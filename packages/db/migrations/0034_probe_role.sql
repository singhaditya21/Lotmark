-- ============================================================================
-- 0034 — A principal for the thing that watches from outside.
--
-- `scripts/prober.mts` runs on another machine and answers the one question the
-- application cannot answer about itself: is the component that raises alerts
-- still running? To do that it has to read `alert_sweeps` and
-- `operational_alerts` for EVERY tenant — a prober that checked one tenant
-- would go quiet about the others, which is the failure it exists to catch.
--
-- Both tables are under FORCE row-level security, so reading them as
-- `lotmark_app` with no tenant set returns nothing at all. The first version of
-- this prober did exactly that and reported "no tenant has ever recorded a
-- sweep" against a database holding a sweep from ninety seconds earlier and
-- five open alerts. It was confidently, legibly wrong, which is the worst thing
-- a monitoring tool can be.
--
-- ── Why not just let lotmark_app do it ──────────────────────────────────────
--
-- Because then it could. Cross-tenant reachability is exactly the property the
-- whole RLS arrangement exists to deny the application, and adding an exception
-- for a convenience is how that kind of guarantee stops being one. The prober
-- is a different principal doing a different job, so it gets its own role and
-- nothing else: no table privileges at all, and EXECUTE on one function.
--
-- ── What the function is allowed to reveal ──────────────────────────────────
--
-- Tenant ids, how long ago each was swept, and counts. No alert text, no
-- summaries, no anything about certificates, people or materials. An operator
-- watching for silence needs to know that a tenant went quiet; they do not need
-- to know what it would have said. Anyone wanting the detail signs in.
-- ============================================================================

CREATE OR REPLACE FUNCTION "lotmark"."ops_probe_summary"()
RETURNS TABLE (
  tenant_id           uuid,
  minutes_since_sweep double precision,
  open_alerts         integer,
  critical_open       integer
)
LANGUAGE sql
STABLE
-- SECURITY DEFINER so it sees past the per-tenant policies. That is the whole
-- point of it; the narrowness of the return shape is what makes it acceptable.
SECURITY DEFINER
SET search_path = lotmark, pg_catalog
AS $$
  SELECT t.id,
         EXTRACT(EPOCH FROM (now() - s.last_swept_at)) / 60,
         COALESCE(s.open_alerts, 0),
         (SELECT count(*)::int FROM lotmark.operational_alerts a
           WHERE a.tenant_id = t.id AND a.resolved_at IS NULL
             AND a.severity = 'critical')
    FROM lotmark.tenants t
    -- LEFT, so a tenant that has NEVER been swept appears with a NULL age
    -- rather than vanishing. A tenant missing from this list would read as one
    -- fewer thing to worry about.
    LEFT JOIN lotmark.alert_sweeps s ON s.tenant_id = t.id
   ORDER BY t.id
$$;

REVOKE ALL ON FUNCTION "lotmark"."ops_probe_summary"() FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lotmark_probe') THEN
    -- No password, like lotmark_app: local connections use the cluster's auth
    -- method, and a deployed instance grants LOGIN with a real secret out of
    -- band. It is a LOGIN role because the prober connects from elsewhere.
    CREATE ROLE lotmark_probe LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA "lotmark" TO lotmark_probe;
GRANT EXECUTE ON FUNCTION "lotmark"."ops_probe_summary"() TO lotmark_probe;

/*
 * Explicitly taken away from lotmark_app.
 *
 * NOT granting it is not enough, and finding that out is the reason this
 * paragraph exists. 0012 set
 *
 *   ALTER DEFAULT PRIVILEGES IN SCHEMA lotmark GRANT EXECUTE ON FUNCTIONS
 *     TO lotmark_app;
 *
 * so every function created in this schema since then is executable by the
 * application the moment it exists. That default is right for the ordinary
 * case — it stops a migration leaving the app unable to call its own helpers —
 * and it means a SECURITY DEFINER function is app-callable by default, which
 * for this one is exactly wrong.
 *
 * Written as it was, this migration granted the application the ability to
 * enumerate every tenant, in a file whose comment said it did not. Verified
 * after the REVOKE: `lotmark_app` is refused, `lotmark_probe` is not.
 *
 * The general lesson matches the one in 0033: in this schema a privilege
 * statement belongs beside every CREATE FUNCTION, and the absence of a GRANT
 * means nothing.
 */
REVOKE ALL ON FUNCTION "lotmark"."ops_probe_summary"() FROM lotmark_app;
