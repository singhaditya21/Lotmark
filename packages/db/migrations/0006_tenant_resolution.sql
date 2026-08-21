-- ============================================================================
-- 0006 — Tenant resolution: the bootstrap hole, deliberately shaped.
--
-- RLS creates a chicken and egg. Every policy is `... = current_tenant()`, and
-- current_tenant() reads a session setting the API can only set once it knows
-- WHICH tenant the request is for. Resolving that from the tenants table is
-- itself blocked by the tenants policy, so the application cannot start.
--
-- The answer is not to weaken the policy. It is one narrow, SECURITY DEFINER
-- function that returns ONLY what routing needs — the id, and the trusted-time
-- fields stamped onto ledger entries. It exposes no configuration, no
-- residency posture beyond the region label, and no other tenant's existence
-- beyond the slug that was already supplied by the caller.
-- ============================================================================

CREATE OR REPLACE FUNCTION "lotmark".resolve_tenant(p_slug text DEFAULT NULL)
RETURNS TABLE (id uuid, slug text, time_source text, region text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lotmark, pg_temp AS $$
  SELECT t.id, t.slug, t.time_source, t.region
  FROM "lotmark"."tenants" t
  WHERE p_slug IS NULL OR t.slug = p_slug
  -- With no slug this returns the earliest tenant, which is what a
  -- single-tenant localhost deployment wants. A multi-tenant deployment
  -- resolves by host and always passes one.
  ORDER BY t.created_at
  LIMIT 1;
$$;

COMMENT ON FUNCTION "lotmark".resolve_tenant IS
  'Bootstrap tenant lookup. SECURITY DEFINER because the caller has no tenant '
  'context yet and the tenants table is under RLS. Returns routing fields only.';

GRANT EXECUTE ON FUNCTION "lotmark".resolve_tenant(text) TO lotmark_app;

-- The application must not read the tenants table directly for routing; the
-- policy already prevents it, and this comment records that the restriction is
-- intentional rather than an oversight to be "fixed" later.
