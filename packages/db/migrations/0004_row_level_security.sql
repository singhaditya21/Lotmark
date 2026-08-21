-- ============================================================================
-- 0004 — Row-Level Security.
--
-- Until this migration, tenant isolation depended on every query remembering to
-- filter by tenant_id. The schema comments claimed RLS enforced it and the API
-- dutifully set `lotmark.tenant_id` on every transaction, but no policy read it
-- — so the protection was documented and absent, which is worse than absent
-- because it stops anyone looking for the real one.
--
-- With policies in place a forgotten WHERE clause returns NOTHING instead of
-- another producer's data. That is the whole point: isolation becomes a
-- property of the database rather than of the developer's memory.
-- ============================================================================

/**
 * The acting tenant, from the session GUC.
 *
 * Returns NULL when unset, which makes every policy match nothing — queries
 * come back empty rather than erroring. Failing CLOSED is deliberate: a code
 * path that forgets `inTenantTransaction` sees no rows, which surfaces quickly
 * in testing, whereas failing open would surface as a data breach in production.
 */
CREATE OR REPLACE FUNCTION "lotmark".current_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := current_setting('lotmark.tenant_id', true);
  IF v IS NULL OR v = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN others THEN
  -- A malformed GUC is a bug, not an authorisation. Treat it as no tenant.
  RETURN NULL;
END;
$$;

/**
 * Apply RLS to every table in the schema.
 *
 * FORCE is used so the policies apply to the table OWNER too. Without it the
 * owner bypasses RLS entirely, which would mean the protection exists in
 * production (where the app connects as a lesser role) but not in development
 * or in the test suite — so the one place it is exercised daily would be the
 * one place it is switched off, and a broken policy would go unnoticed.
 *
 * Three tables need a different predicate:
 *   tenants          — scoped by its own id, not a tenant_id column
 *   study_equipment  — a join table; tenancy comes from the study
 *   facility_lots    — a join table; tenancy comes from the facility
 */
DO $$
DECLARE
  t record;
  predicate text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'lotmark' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    predicate := CASE t.relname
      WHEN 'tenants' THEN
        'id = "lotmark".current_tenant()'
      WHEN 'study_equipment' THEN
        'EXISTS (SELECT 1 FROM "lotmark"."studies" s
                  WHERE s.id = study_id AND s.tenant_id = "lotmark".current_tenant())'
      WHEN 'facility_lots' THEN
        'EXISTS (SELECT 1 FROM "lotmark"."facilities" f
                  WHERE f.id = facility_id AND f.tenant_id = "lotmark".current_tenant())'
      ELSE
        'tenant_id = "lotmark".current_tenant()'
    END;

    EXECUTE format('ALTER TABLE "lotmark".%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE "lotmark".%I FORCE ROW LEVEL SECURITY', t.relname);

    -- One policy covering every command. USING filters what is visible;
    -- WITH CHECK stops a row being written into another tenant, which a
    -- read-only policy would happily allow.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON "lotmark".%I
         USING (%s) WITH CHECK (%s)',
      t.relname, predicate, predicate);
  END LOOP;
END $$;

/**
 * The migration and seed need to act across tenants — creating the first one,
 * and truncating everything. Both run as the owner, and the owner is now
 * subject to its own policies, so a bypass is required for exactly those tasks.
 *
 * `lotmark.bypass_rls` is checked by the policies through current_tenant()
 * returning NULL... which is NOT enough on its own. Instead the seed sets the
 * tenant GUC before writing, and provisioning a NEW tenant uses this function,
 * which is SECURITY DEFINER and therefore not subject to the caller's policies.
 */
CREATE OR REPLACE FUNCTION "lotmark".provision_tenant(
  p_id uuid, p_slug text, p_name text, p_short_name text,
  p_conformance_frame text, p_lot_numbering_template text, p_data_residency text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lotmark, pg_temp AS $$
BEGIN
  INSERT INTO "lotmark"."tenants"
    (id, slug, name, short_name, conformance_frame, lot_numbering_template, data_residency)
  VALUES (p_id, p_slug, p_name, p_short_name, p_conformance_frame,
          p_lot_numbering_template, p_data_residency);
  RETURN p_id;
END;
$$;

COMMENT ON FUNCTION "lotmark".provision_tenant IS
  'Creates a tenant. SECURITY DEFINER because the caller has no tenant context yet, '
  'and the tenants table is itself under RLS. This is the only sanctioned way in.';
