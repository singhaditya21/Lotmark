-- ============================================================================
-- 0029 — Key custody does not silently go backwards.
--
-- ── What already exists, so this is not mistaken for it ─────────────────────
--
-- `loadConfig` (apps/api/src/config.ts) already refuses to start a production
-- process on a custody class that is not fit for one, and refuses ANY process
-- on a class this build cannot construct. Those guards are good and this
-- migration does not duplicate or replace them.
--
-- ── The failure a start-up guard cannot see ─────────────────────────────────
--
-- A start-up guard asks "is this process in production", and the only source of
-- that answer is the process's own environment. The accident worth guarding
-- against is a developer machine pointed at a production DATABASE_URL: NODE_ENV
-- is `development`, both guards are satisfied because they are satisfied, and a
-- `dev_file` key is minted and registered against the production tenant.
--
-- `signing_keys.custody` is PRINTED ON EVERY CERTIFICATE that key signs, and
-- the table is append-only. There is no version of this that gets tidied up
-- afterwards.
--
-- The database is the one thing the two processes share, and it is the only
-- party to that accident with enough information to notice it — because it can
-- see where the tenant's keys have been, which no single process can. So the
-- invariant belongs here: a tenant that has ever held a production-grade key
-- does not afterwards acquire one that is not.
--
-- It is a ratchet, not an ordering. There is no claim here that `hsm` beats
-- `kms`; only that having once reached a class fit for production, you do not
-- leave it by accident.
--
-- ── Two copies of one fact ──────────────────────────────────────────────────
--
-- The list below is the same fact as `PRODUCTION_GRADE` in
-- apps/api/src/services/custody.ts, written twice, which is the shape of defect
-- this codebase has spent a week removing. It is written twice on purpose — the
-- check has to run where the INSERT happens, and that is here — and the copies
-- are held together by a test rather than by hope: see
-- apps/api/src/__tests__/custody-ratchet.test.ts, which reads both and compares
-- them class by class. Add a custody class and that test fails until both sides
-- know about it.
-- ============================================================================

CREATE OR REPLACE FUNCTION "lotmark"."custody_is_production_grade"(cls text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  -- Must equal PRODUCTION_GRADE in apps/api/src/services/custody.ts.
  -- A test asserts it does; see the header of migration 0029.
  SELECT cls IN ('env', 'kms', 'hsm')
$$;

COMMENT ON FUNCTION "lotmark"."custody_is_production_grade"(text) IS
  'Whether a custody class is fit to hold a key outside development. Mirrors '
  'PRODUCTION_GRADE in apps/api/src/services/custody.ts, and a test asserts '
  'the two agree.';

CREATE OR REPLACE FUNCTION "lotmark"."refuse_custody_downgrade"()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY DEFINER so the check sees the tenant's whole key history. Under
-- FORCE RLS the caller's policies apply to the lookup as well as to the insert,
-- and a check that can be made to see nothing is not a check.
SECURITY DEFINER
SET search_path = lotmark, pg_catalog
AS $$
DECLARE
  reached text;
BEGIN
  IF lotmark.custody_is_production_grade(NEW.custody) THEN
    RETURN NEW;
  END IF;

  -- Where this tenant has been: the class of any key it holds now, and the
  -- destination of any recorded move. A key moved into a KMS and later retired
  -- still counts — the tenant demonstrably had somewhere better to put it.
  SELECT c INTO reached FROM (
    SELECT custody AS c FROM lotmark.signing_keys
     WHERE tenant_id = NEW.tenant_id AND id IS DISTINCT FROM NEW.id
    UNION ALL
    SELECT to_custody FROM lotmark.key_custody_events
     WHERE tenant_id = NEW.tenant_id
  ) AS seen
  WHERE lotmark.custody_is_production_grade(c)
  LIMIT 1;

  IF reached IS NOT NULL THEN
    RAISE EXCEPTION
      'This tenant already holds keys under % custody, and this would register '
      'key % under %, which is not fit for production use. The usual cause is a '
      'development process pointed at a production database: check DATABASE_URL '
      'before anything else. Custody is printed on every certificate a key '
      'signs, so this is refused rather than recorded.',
      reached, NEW.key_version, NEW.custody
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "lotmark"."refuse_custody_downgrade"() FROM PUBLIC;

DROP TRIGGER IF EXISTS "signing_keys_custody_ratchet" ON "lotmark"."signing_keys";

CREATE TRIGGER "signing_keys_custody_ratchet"
  BEFORE INSERT OR UPDATE OF "custody" ON "lotmark"."signing_keys"
  FOR EACH ROW EXECUTE FUNCTION "lotmark"."refuse_custody_downgrade"();
