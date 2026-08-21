-- ============================================================================
-- 0022 — One customer must not see another customer's business.
--
-- Row-level security has been tenant-scoped since 0004, and the producer and
-- both its customers live in the SAME tenant — they are organisations within
-- it. So `tenant_id = current_tenant()` puts every customer's orders, price-tier
-- claims and vault holdings in front of every other customer's session.
--
-- Verified before writing this: two customer organisations exist, both have
-- orders, and `SELECT * FROM pg_policies WHERE qual LIKE '%organisation%'`
-- returned NOTHING. The comment on `vault_holdings` has said since 0000 that
-- "a customer sees only their organisation's rows; RLS enforces it". It did not.
--
-- ── Restrictive, and failing closed ─────────────────────────────────────────
--
-- The policies are RESTRICTIVE, so they AND with the existing tenant rule
-- rather than offering a second way to qualify. A permissive policy here would
-- have widened access rather than narrowed it, which is the classic way this
-- goes wrong.
--
-- With no organisation context set, they match NOTHING. That is deliberate and
-- it has a cost: anything that reads these tables without setting the context
-- silently sees an empty set. The most important such reader is
-- `certificate_holders()`, which decides who receives a WITHDRAWAL NOTICE and
-- is called by the notification jobs and by the withdrawal screen. An empty
-- holder list there does not look like an error — it looks like nobody holds
-- the certificate. Both callers now set the context, and a test asserts the
-- holder list is not empty when it should not be.
-- ============================================================================

/**
 * The acting organisation, and whether it is the producer.
 *
 * Two settings rather than one. The KIND decides whether the row filter applies
 * at all — a producer-side actor sees the whole tenant's commercial data
 * because that is their job — and the ID decides which rows a customer sees.
 *
 * Deriving the kind from the id would need a lookup inside every policy
 * evaluation, on a table that is itself under RLS.
 */
CREATE OR REPLACE FUNCTION "lotmark".current_organisation() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := current_setting('lotmark.organisation_id', true);
  IF v IS NULL OR v = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

/**
 * Is the caller acting on the producer's side?
 *
 * Returns false when unset, so an actor that has not declared itself sees no
 * customer data at all. Failing closed here means a forgotten context surfaces
 * as "no rows" in testing rather than as one laboratory reading another's
 * orders in production.
 */
CREATE OR REPLACE FUNCTION "lotmark".acting_as_producer() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('lotmark.organisation_kind', true), '') = 'producer';
$$;

/**
 * Apply organisation isolation to a table that names an organisation directly.
 */
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders', 'entitlements', 'vault_holdings'] LOOP
    EXECUTE format(
      'CREATE POLICY organisation_isolation ON "lotmark".%I
         AS RESTRICTIVE
         USING ("lotmark".acting_as_producer() OR organisation_id = "lotmark".current_organisation())
         WITH CHECK ("lotmark".acting_as_producer() OR organisation_id = "lotmark".current_organisation())',
      t);
  END LOOP;
END $$;

/**
 * And to the tables that reach an organisation through a parent.
 *
 * Written out rather than generated: each join is different, and a generated
 * one would be a template nobody could read at the moment it mattered.
 */
CREATE POLICY organisation_isolation ON "lotmark"."order_lines"
  AS RESTRICTIVE
  USING ("lotmark".acting_as_producer() OR EXISTS (
    SELECT 1 FROM "lotmark"."orders" o
    WHERE o.id = order_id AND o.organisation_id = "lotmark".current_organisation()))
  WITH CHECK ("lotmark".acting_as_producer() OR EXISTS (
    SELECT 1 FROM "lotmark"."orders" o
    WHERE o.id = order_id AND o.organisation_id = "lotmark".current_organisation()));

CREATE POLICY organisation_isolation ON "lotmark"."shipments"
  AS RESTRICTIVE
  USING ("lotmark".acting_as_producer() OR EXISTS (
    SELECT 1 FROM "lotmark"."orders" o
    WHERE o.id = order_id AND o.organisation_id = "lotmark".current_organisation()))
  WITH CHECK ("lotmark".acting_as_producer() OR EXISTS (
    SELECT 1 FROM "lotmark"."orders" o
    WHERE o.id = order_id AND o.organisation_id = "lotmark".current_organisation()));

CREATE POLICY organisation_isolation ON "lotmark"."logger_readings"
  AS RESTRICTIVE
  USING ("lotmark".acting_as_producer() OR EXISTS (
    SELECT 1 FROM "lotmark"."shipments" s
    JOIN "lotmark"."orders" o ON o.id = s.order_id
    WHERE s.id = shipment_id AND o.organisation_id = "lotmark".current_organisation()))
  WITH CHECK ("lotmark".acting_as_producer() OR EXISTS (
    SELECT 1 FROM "lotmark"."shipments" s
    JOIN "lotmark"."orders" o ON o.id = s.order_id
    WHERE s.id = shipment_id AND o.organisation_id = "lotmark".current_organisation()));

/**
 * Notifications belong to a PERSON.
 *
 * The organisation column exists for the acknowledgement key and is nullable
 * on older rows, so the rule is written against the recipient: a customer sees
 * notices addressed to them, and the producer sees all of them because it sends
 * them and has to know which were unreachable.
 */
CREATE POLICY organisation_isolation ON "lotmark"."notifications"
  AS RESTRICTIVE
  USING ("lotmark".acting_as_producer() OR EXISTS (
    SELECT 1 FROM "lotmark"."users" u
    WHERE u.id = recipient_user_id AND u.organisation_id = "lotmark".current_organisation()))
  WITH CHECK ("lotmark".acting_as_producer() OR EXISTS (
    SELECT 1 FROM "lotmark"."users" u
    WHERE u.id = recipient_user_id AND u.organisation_id = "lotmark".current_organisation()));

/**
 * `certificate_holders()` becomes SECURITY DEFINER.
 *
 * It reads orders and vault_holdings ACROSS organisations — that is the whole
 * point of it: "everyone holding this certificate" is a producer-side question
 * whose answer necessarily spans customers. Under the restrictive policies
 * above, a caller that had not set the producer context would get an empty
 * list, and an empty holder list is indistinguishable from "nobody holds this".
 * On a withdrawal screen that is the worst possible ambiguity.
 *
 * Making it a definer function means the answer does not depend on the caller
 * remembering to set a GUC. It remains tenant-scoped: the certificate id is the
 * only way in, and a caller can only obtain one for a certificate their tenant
 * context already lets them see.
 */
CREATE OR REPLACE FUNCTION "lotmark".certificate_holders(
  p_certificate_id uuid, p_issue_number integer
)
RETURNS TABLE (
  organisation_id uuid, organisation_name text, quantity bigint,
  basis text, contact_user_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lotmark, pg_temp AS $$
  WITH window_bounds AS (
    SELECT i.issued_at AS from_at,
           (SELECT min(later.issued_at) FROM "lotmark"."certificate_issues" later
            WHERE later.certificate_id = p_certificate_id
              AND later.issue_number > p_issue_number) AS to_at,
           (p_issue_number = (SELECT min(first.issue_number)
                              FROM "lotmark"."certificate_issues" first
                              WHERE first.certificate_id = p_certificate_id)) AS is_first,
           c.lot_id
    FROM "lotmark"."certificate_issues" i
    JOIN "lotmark"."certificates" c ON c.id = i.certificate_id
    WHERE i.certificate_id = p_certificate_id AND i.issue_number = p_issue_number
  ),
  from_orders AS (
    SELECT o.organisation_id, sum(ol.quantity)::bigint AS quantity,
           'order'::text AS basis,
           (array_agg(o.placed_by_user_id ORDER BY o.created_at))[1] AS contact_user_id
    FROM "lotmark"."order_lines" ol
    JOIN "lotmark"."orders" o ON o.id = ol.order_id
    CROSS JOIN window_bounds w
    WHERE ol.lot_id = w.lot_id
      AND (w.is_first OR o.created_at >= w.from_at)
      AND (w.to_at IS NULL OR o.created_at < w.to_at)
      AND o.state <> 'cancelled'
    GROUP BY o.organisation_id
  ),
  from_vault AS (
    SELECT v.organisation_id, sum(v.quantity)::bigint AS quantity,
           'self-declared holding'::text AS basis, NULL::uuid AS contact_user_id
    FROM "lotmark"."vault_holdings" v
    CROSS JOIN window_bounds w
    WHERE v.lot_id = w.lot_id AND v.quantity > 0
      AND (w.is_first OR v.acquired_on >= w.from_at::date)
      AND (w.to_at IS NULL OR v.acquired_on < w.to_at::date)
    GROUP BY v.organisation_id
  ),
  merged AS (
    SELECT * FROM from_orders UNION ALL SELECT * FROM from_vault
  )
  SELECT m.organisation_id, org.name, sum(m.quantity)::bigint,
         string_agg(DISTINCT m.basis, ' + '),
         (array_agg(m.contact_user_id) FILTER (WHERE m.contact_user_id IS NOT NULL))[1]
  FROM merged m
  JOIN "lotmark"."organisations" org ON org.id = m.organisation_id
  GROUP BY m.organisation_id, org.name;
$$;

REVOKE EXECUTE ON FUNCTION "lotmark".certificate_holders(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lotmark".current_organisation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lotmark".acting_as_producer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "lotmark".certificate_holders(uuid, integer) TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".current_organisation() TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".acting_as_producer() TO lotmark_app;

COMMENT ON FUNCTION "lotmark".certificate_holders(uuid, integer) IS
  'Everyone holding an issue, across organisations. SECURITY DEFINER because '
  'the restrictive organisation policies would otherwise return an empty list '
  'to a caller that forgot to set the producer context — and an empty holder '
  'list is indistinguishable from nobody holding the certificate.';
