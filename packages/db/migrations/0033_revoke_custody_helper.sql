-- ============================================================================
-- 0033 — Take EXECUTE on custody_is_production_grade away from PUBLIC.
--
-- 0029 created two functions and revoked PUBLIC's EXECUTE on one of them. The
-- trigger function got the REVOKE because it was obviously sensitive; the
-- little IMMUTABLE helper beside it did not, because it looked like a lookup
-- table. PostgreSQL grants EXECUTE on new functions to PUBLIC by default, so
-- "did not think about it" and "granted it to everybody" are the same act.
--
-- The installation qualification caught it, which is what it is for:
--
--   FAIL  PUBLIC can execute no lotmark function — 1 function(s)
--
-- CI runs the IQ, so 0029 as committed would have failed the build. Worth
-- recording rather than quietly fixing: the check earned its place, and the
-- lesson is that a REVOKE belongs beside every CREATE FUNCTION in this schema,
-- not beside the ones that feel dangerous.
--
-- Nothing depended on the grant. The helper is called from a trigger owned by
-- the schema owner and from a test that connects as `lotmark_app`, and
-- `lotmark_app` keeps its access explicitly below.
-- ============================================================================

REVOKE ALL ON FUNCTION "lotmark"."custody_is_production_grade"(text) FROM PUBLIC;

-- Explicit, because the test in apps/api/src/__tests__/custody-ratchet.test.ts
-- calls it as lotmark_app to check that the database and custody.ts agree.
GRANT EXECUTE ON FUNCTION "lotmark"."custody_is_production_grade"(text) TO lotmark_app;
