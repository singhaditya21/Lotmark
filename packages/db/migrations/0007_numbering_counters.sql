-- ============================================================================
-- 0007 — Identifier counters.
--
-- Codes were rendered from `count(*)` over the target table. That races: two
-- concurrent creates read the same count, render the same identifier, and the
-- unique index fails one of them with a constraint violation rather than
-- giving it the next number. It also breaks the moment a row is deleted or a
-- lot is superseded, because the count stops tracking the high-water mark.
--
-- A counter row per (tenant, entity, scope) is taken under a row lock, so
-- concurrent creates serialise on the counter instead of colliding.
-- ============================================================================

CREATE TABLE "lotmark"."numbering_counters" (
  tenant_id  uuid NOT NULL REFERENCES "lotmark"."tenants"(id) ON DELETE RESTRICT,
  entity     text NOT NULL,
  -- 'all' for a never-resetting series, or the year for a yearly one.
  scope      text NOT NULL DEFAULT 'all',
  next_value bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity, scope),
  CONSTRAINT numbering_counter_advances CHECK (next_value >= 1)
);

ALTER TABLE "lotmark"."numbering_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lotmark"."numbering_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lotmark"."numbering_counters"
  USING (tenant_id = "lotmark".current_tenant())
  WITH CHECK (tenant_id = "lotmark".current_tenant());

GRANT SELECT, INSERT, UPDATE ON "lotmark"."numbering_counters" TO lotmark_app;

-- A counter must never go backwards: reusing an identifier would let two
-- different materials share a lot code, and a certificate cite the wrong one.
CREATE OR REPLACE FUNCTION "lotmark".numbering_counter_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'numbering counter for %/% cannot go backwards (% -> %)',
      OLD.entity, OLD.scope, OLD.next_value, NEW.next_value;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER numbering_counters_monotonic
  BEFORE UPDATE ON "lotmark"."numbering_counters"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".numbering_counter_monotonic();
