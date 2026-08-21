-- ============================================================================
-- 0009 — Who holds a certificate.
--
-- If an assigned value turns out to be wrong, everyone holding that certificate
-- must be told. That is the product's central safety obligation, and it is only
-- as good as the holder list.
--
-- The obvious implementation derives holders from order lines. That is WRONG,
-- and the schema already knew it: `vault_holding.source` admits 'qr_scan',
-- 'upload' and 'import' alongside 'order'. A laboratory that received a vial as
-- a sample, a free replacement, or through a proficiency-testing distribution
-- has no order line — and under an order-derived list would receive no
-- withdrawal notice at all.
--
-- The holder set is therefore order lines UNION vault holdings, with the vault
-- half marked self-declared so a notification report can say how each holder
-- became known.
-- ============================================================================

ALTER TABLE "lotmark"."vault_holdings"
  ADD COLUMN source text NOT NULL DEFAULT 'order',
  ADD COLUMN acquired_on date,
  ADD CONSTRAINT vault_holding_source_known
    CHECK (source IN ('order', 'qr_scan', 'upload', 'import', 'sample'));

/**
 * Everyone holding a given certificate issue.
 *
 * `p_issue_number` selects the window: a holder is anyone whose acquisition
 * falls between this issue and the next. Keyed at ALLOCATION time, not order
 * placement — an order placed before an issue but fulfilled after it received
 * the later document.
 */
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
      AND o.created_at >= w.from_at
      AND (w.to_at IS NULL OR o.created_at < w.to_at)
      AND o.state <> 'cancelled'
    GROUP BY o.organisation_id
  ),
  from_vault AS (
    -- Self-declared holdings, including those acquired with no order at all.
    SELECT v.organisation_id, sum(v.quantity)::bigint AS quantity,
           'self-declared holding'::text AS basis, NULL::uuid AS contact_user_id
    FROM "lotmark"."vault_holdings" v
    CROSS JOIN window_bounds w
    WHERE v.lot_id = w.lot_id AND v.quantity > 0
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

GRANT EXECUTE ON FUNCTION "lotmark".certificate_holders(uuid, integer) TO lotmark_app;

-- Notifications get an acknowledgement key precise enough to be useful.
-- The prototype keyed reissue acknowledgements on (order, certificate), so
-- acknowledging issue 2 silently marked issue 3 acknowledged as well.
ALTER TABLE "lotmark"."notifications"
  ADD COLUMN certificate_id uuid REFERENCES "lotmark"."certificates"(id),
  ADD COLUMN issue_number integer,
  ADD COLUMN organisation_id uuid REFERENCES "lotmark"."organisations"(id);

CREATE UNIQUE INDEX notifications_one_per_issue_per_org
  ON "lotmark"."notifications" (certificate_id, issue_number, organisation_id, subject_table)
  WHERE certificate_id IS NOT NULL;
