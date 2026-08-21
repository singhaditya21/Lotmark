-- ============================================================================
-- 0020 — When a holding was acquired, and why we think so.
--
-- `vault_holdings.acquired_on` decides which certificate ISSUE a holder is
-- holding, and therefore who receives a withdrawal notice. It has been nullable
-- since 0009 and every row in the demonstration data is NULL, because
-- `seed/run.ts` never set it — so the column that decides who gets warned has
-- so far decided nothing.
--
-- ── The honest way to fill in a date nobody recorded ────────────────────────
--
-- The obvious backfill is `coalesce(acquired_on, now())`. That writes a
-- FALSEHOOD into a record used to decide who is told their certificate has been
-- withdrawn — and it is not a detectable falsehood, because afterwards the row
-- looks exactly like one somebody entered.
--
-- So the date is derived where it can be, and where it cannot, the EARLIEST
-- date the holding could possibly have existed is used — the lot's release —
-- and the row says which of those happened. `acquired_on_basis` makes the
-- provenance part of the record rather than part of this migration's commit
-- message:
--
--   recorded            somebody stated it
--   derived_from_order  taken from the order that supplied the material
--   earliest_possible   unknown; the lot's release date, which is a LOWER
--                       BOUND rather than a claim
--
-- The lower bound is the safe direction for the one decision this column
-- drives. An acquisition date that is too early puts the holder on an earlier
-- issue's notice list, so they are told sooner and possibly more than once.
-- Too late would have them silently dropped off it.
--
-- ── The other half of the same problem ──────────────────────────────────────
--
-- With NULLs gone, an asymmetry in `certificate_holders` is bare. The order
-- half matches a two-sided window — placed after this issue and before the
-- next. The vault half has only an upper bound, so a single holding matches
-- EVERY issue up to the one current when it was acquired, and a withdrawal of
-- issue 1 notifies somebody who has been holding issue 3 for a year. Fixed
-- below, with the first issue deliberately left open at the bottom: material
-- distributed as a sample before the certificate existed belongs to issue 1,
-- not to nothing.
-- ============================================================================

ALTER TABLE "lotmark"."vault_holdings"
  ADD COLUMN acquired_on_basis text NOT NULL DEFAULT 'recorded',
  ADD CONSTRAINT vault_holding_basis_known
    CHECK (acquired_on_basis IN ('recorded', 'derived_from_order', 'earliest_possible'));

/**
 * The derivation, in ONE place.
 *
 * The backfill below and `seed/run.ts` both need it, and two implementations of
 * "when did this laboratory get this material" would drift — leaving seeded
 * data and migrated data disagreeing about who gets a withdrawal notice. The
 * seed calls this function rather than reimplementing the rules in TypeScript.
 *
 * An organisation that ordered the same lot twice gets the EARLIEST order,
 * which is the lower bound and the safe direction: too early puts them on an
 * earlier issue's notice list, too late drops them off it silently.
 */
CREATE OR REPLACE FUNCTION "lotmark".vault_acquisition_for(p_org uuid, p_lot uuid)
RETURNS TABLE (acquired_on date, basis text)
LANGUAGE sql STABLE AS $$
  SELECT
    coalesce(o.placed_on, l.released_at::date, l.created_at::date),
    CASE WHEN o.placed_on IS NOT NULL THEN 'derived_from_order' ELSE 'earliest_possible' END
  FROM "lotmark"."lots" l
  LEFT JOIN LATERAL (
    SELECT min(ord.placed_on) AS placed_on
    FROM "lotmark"."order_lines" ol
    JOIN "lotmark"."orders" ord ON ord.id = ol.order_id
    WHERE ol.lot_id = p_lot AND ord.organisation_id = p_org AND ord.state <> 'cancelled'
  ) o ON true
  WHERE l.id = p_lot;
$$;

REVOKE EXECUTE ON FUNCTION "lotmark".vault_acquisition_for(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "lotmark".vault_acquisition_for(uuid, uuid) TO lotmark_app;

-- A LATERAL cannot reference the UPDATE target, so the row is reached through a
-- second reference to the same table and matched back on the primary key.
UPDATE "lotmark"."vault_holdings" v
SET acquired_on = d.acquired_on,
    acquired_on_basis = d.basis
FROM "lotmark"."vault_holdings" src
CROSS JOIN LATERAL "lotmark".vault_acquisition_for(src.organisation_id, src.lot_id) d
WHERE v.id = src.id AND v.acquired_on IS NULL;

ALTER TABLE "lotmark"."vault_holdings"
  ALTER COLUMN acquired_on SET NOT NULL;

/**
 * NO default is set, deliberately.
 *
 * `DEFAULT CURRENT_DATE` would be the convenient choice and would quietly
 * stamp today onto every historical row inserted by a seed or an import —
 * a date nobody stated, indistinguishable afterwards from one somebody did.
 * Failing the INSERT instead forces the caller to decide, which for this
 * column is the whole point.
 */

-- ---------------------------------------------------------------------------
-- The holder window, symmetric at last.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "lotmark".certificate_holders(
  p_certificate_id uuid, p_issue_number integer
)
RETURNS TABLE (
  organisation_id uuid, organisation_name text, quantity bigint,
  basis text, contact_user_id uuid
)
LANGUAGE sql STABLE AS $$
  WITH window_bounds AS (
    SELECT i.issued_at AS from_at,
           (SELECT min(later.issued_at) FROM "lotmark"."certificate_issues" later
            WHERE later.certificate_id = p_certificate_id
              AND later.issue_number > p_issue_number) AS to_at,
           -- Is this the FIRST issue? If so the window has no bottom: material
           -- distributed as a sample before the certificate existed is held
           -- against issue 1, not against nothing at all.
           (p_issue_number = (SELECT min(first.issue_number)
                              FROM "lotmark"."certificate_issues" first
                              WHERE first.certificate_id = p_certificate_id)) AS is_first,
           c.lot_id
    FROM "lotmark"."certificate_issues" i
    JOIN "lotmark"."certificates" c ON c.id = i.certificate_id
    WHERE i.certificate_id = p_certificate_id AND i.issue_number = p_issue_number
  ),
  from_orders AS (
    -- Postgres has no min(uuid); take the earliest order's placer, which is
    -- also the more sensible contact than an arbitrary one.
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
    /**
     * Self-declared holdings, including those acquired with no order at all.
     *
     * Now bounded on BOTH sides, matching the order half. Previously only the
     * upper bound was applied, so one holding matched every issue up to the one
     * current when it was acquired — and withdrawing issue 1 notified an
     * organisation that had been holding issue 3 for a year.
     */
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
    SELECT * FROM from_orders
    UNION ALL
    SELECT * FROM from_vault
  )
  SELECT m.organisation_id, org.name, sum(m.quantity)::bigint,
         string_agg(DISTINCT m.basis, ' + '),
         (array_agg(m.contact_user_id) FILTER (WHERE m.contact_user_id IS NOT NULL))[1]
  FROM merged m
  JOIN "lotmark"."organisations" org ON org.id = m.organisation_id
  GROUP BY m.organisation_id, org.name;
$$;

REVOKE EXECUTE ON FUNCTION "lotmark".certificate_holders(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "lotmark".certificate_holders(uuid, integer) TO lotmark_app;

COMMENT ON COLUMN "lotmark"."vault_holdings"."acquired_on_basis" IS
  'How acquired_on was arrived at: recorded by a person, derived from the '
  'supplying order, or the earliest date the holding could have existed. The '
  'date decides who receives a withdrawal notice, so how it was obtained is '
  'part of the record rather than an assumption a reader has to make.';
