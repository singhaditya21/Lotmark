-- ============================================================================
-- 0005 — The application role.
--
-- WHY THIS EXISTS, in one sentence: a PostgreSQL superuser bypasses row-level
-- security unconditionally, FORCE included, so an application connecting as one
-- has no tenant isolation at all — and, worse, the isolation looks fine in
-- development and only starts applying in production, which means the policies
-- are first exercised in the one place a mistake is expensive.
--
-- The application therefore connects as `lotmark_app`, which is NOT a superuser
-- and NOT the schema owner. RLS applies to it, so development, the test suite
-- and production all exercise the same policies.
--
-- Role creation is cluster-level rather than database-level. In a managed
-- deployment a DBA creates this role and the migration only grants to it; the
-- CREATE below is idempotent so both paths work.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lotmark_app') THEN
    -- No password: local connections use the cluster's configured auth method.
    -- A deployed instance grants LOGIN with a real secret out of band.
    CREATE ROLE lotmark_app LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA "lotmark" TO lotmark_app;

-- Data access, but no DDL: the application cannot add, alter or drop a table,
-- so it cannot create one that is missing an RLS policy.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "lotmark" TO lotmark_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "lotmark" TO lotmark_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "lotmark" TO lotmark_app;

-- Future tables inherit the same grants, so a new migration cannot accidentally
-- leave the application unable to read its own schema.
ALTER DEFAULT PRIVILEGES IN SCHEMA "lotmark"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lotmark_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "lotmark"
  GRANT USAGE, SELECT ON SEQUENCES TO lotmark_app;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by privilege as well as by trigger.
--
-- The triggers already refuse. Revoking as well means an attacker who finds a
-- way to disable a trigger still holds no grant, and a future migration that
-- drops a trigger by accident does not silently open a delete path.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "lotmark"."audit_ledger"      FROM lotmark_app;
REVOKE UPDATE, DELETE ON "lotmark"."signatures"        FROM lotmark_app;
REVOKE UPDATE, DELETE ON "lotmark"."state_transitions" FROM lotmark_app;
REVOKE DELETE           ON "lotmark"."audit_checkpoints" FROM lotmark_app;

-- The application must never TRUNCATE: it is DDL, it bypasses row triggers, and
-- it is precisely how an append-only ledger would be emptied without trace.
-- (No TRUNCATE grant is given above; this comment records the intent.)

-- provision_tenant is SECURITY DEFINER and runs as the owner, so the app role
-- may call it without holding the privileges it needs internally.
GRANT EXECUTE ON FUNCTION "lotmark".provision_tenant(uuid, text, text, text, text, text, text)
  TO lotmark_app;
