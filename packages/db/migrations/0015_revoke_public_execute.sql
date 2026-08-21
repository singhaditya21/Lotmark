-- ============================================================================
-- 0015 — Close the PUBLIC EXECUTE hole properly, and make it assertable.
--
-- 0012 revoked EXECUTE from PUBLIC and set ALTER DEFAULT PRIVILEGES so future
-- functions would not get it. Verified afterwards: NINE functions still carry
-- `=X/owner`, including the SECURITY DEFINER public_signing_key, and a function
-- created fresh today STILL gets PUBLIC:
--
--   CREATE FUNCTION lotmark.acl_probe() ...
--   proacl → {=X/adityasingh, adityasingh=X/..., lotmark_app=X/...}
--
-- Whatever the reason, the conclusion is the one that matters: ALTER DEFAULT
-- PRIVILEGES is not a guarantee here, and a security property that depends on
-- a mechanism nobody re-checks is not a property, it is a hope.
--
-- So this migration revokes explicitly now that every function exists, and adds
-- a function that ENUMERATES any offender. A test asserts the list is empty, so
-- a function added in a later migration cannot reopen the hole silently — which
-- is exactly how it stayed open the first time.
-- ============================================================================

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "lotmark" FROM PUBLIC;

-- The roles that must keep it, stated explicitly rather than inherited.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "lotmark" TO lotmark_app;

GRANT EXECUTE ON FUNCTION "lotmark".all_tenants()            TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".current_tenant()         TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".lp(text)                 TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".jsonb_canonical(jsonb)   TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".verify_audit_chain(uuid, bigint, bigint) TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".audit_payload(text, uuid, bigint, text, text, text, text,
  text, text, text, timestamptz, text, text, jsonb) TO lotmark_signer;

/**
 * Functions PUBLIC can still execute.
 *
 * Empty is the only acceptable answer. Returned as data rather than raised so a
 * test can name every offender at once instead of failing on the first.
 *
 * SECURITY DEFINER functions are flagged separately: those run as the OWNER, so
 * PUBLIC executing one is not merely broad access, it is privileged access.
 */
CREATE OR REPLACE FUNCTION "lotmark".functions_public_can_execute()
RETURNS TABLE (function_name text, is_security_definer boolean)
LANGUAGE sql STABLE AS $$
  SELECT p.proname::text, p.prosecdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'lotmark'
    AND (p.proacl IS NULL
         OR EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::text LIKE '=%'))
  ORDER BY p.prosecdef DESC, p.proname;
$$;

-- This one too, or the auditor of the hole is itself in the hole.
REVOKE EXECUTE ON FUNCTION "lotmark".functions_public_can_execute() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "lotmark".functions_public_can_execute() TO lotmark_app;
