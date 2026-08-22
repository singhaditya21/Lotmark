-- ============================================================================
-- 0027 — Four facts, one home.
--
-- `tenants.bilingual`, `.adr`, `.publications` and `.gov_tier` hold the same
-- four facts as `config_entries` of kind `flag`. They already DISAGREED: the
-- columns read true, true, true, true and the flag payloads read
-- enabled: false for all four.
--
-- Nothing read either store, so the disagreement was harmless — and it was
-- harmless only until the first line of gating code, which would have picked a
-- winner silently and made that choice load-bearing. The schema makes this
-- argument about itself two fields further down, for `lot_numbering_template`:
--
--     Two sources of truth for one fact is how a lot ends up with two
--     different codes depending on which code path rendered it — which is
--     exactly what happened before the counter was introduced.
--
-- ── Configuration wins ──────────────────────────────────────────────────────
--
-- A flag is a tenant DECISION, and decisions belong in the versioned model with
-- the rest of them: drafted, diffed, signed, published, and reversible by
-- publishing a new version. A boolean column is none of those things. So the
-- columns go and the config entries stay.
--
-- `lot_numbering_template` keeps its column, deliberately: it is documented as
-- display-only, it is kept in step by the seed, and the tenant-profile screen
-- reads it. These four are read by nothing at all.
--
-- ── Two of them are deleted outright ────────────────────────────────────────
--
-- `adr` and `publications` name features that do not exist anywhere in the
-- repository — no route, no table, no screen, no test. Wiring them to a
-- resolver would have been trivial and dishonest: a flag that gates nothing
-- reads, to an administrator looking at the configuration console, exactly like
-- a flag that gates something.
-- ============================================================================

ALTER TABLE "lotmark"."tenants"
  DROP COLUMN "bilingual",
  DROP COLUMN "adr",
  DROP COLUMN "publications",
  DROP COLUMN "gov_tier";

COMMENT ON COLUMN "lotmark"."tenants"."lot_numbering_template" IS
  'DISPLAY ONLY. The authoritative template is a `numbering` config entry. '
  'This column survives where the four flag columns did not because it is '
  'actually read — by the tenant-profile screen — and is kept in step by the '
  'seed. See migration 0027.';
