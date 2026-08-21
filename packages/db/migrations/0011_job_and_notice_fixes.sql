-- ============================================================================
-- 0011 — Fixes for defects found by specifying the work properly.
--
-- Three of these are live bugs in code already shipped. They are recorded here
-- rather than quietly patched because each is a case where the system produced
-- a FALSE RECORD, which is the failure mode this product exists to prevent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The idempotency guarantee did not hold where it mattered most.
--
-- `notice_once_per_threshold` is a plain UNIQUE, and in SQL two NULLs are
-- DISTINCT. The monitoring-overdue notice passes NULL for organisation_id — it
-- is an internal finding, not a customer notice — so ON CONFLICT DO NOTHING
-- never conflicted and every run raised another CAPA.
--
-- Verified before fixing: three runs produced NCR-1002, NCR-1003, NCR-1004 for
-- one overdue point. The expiry notice appeared idempotent only because it
-- always carries a real organisation.
--
-- NULLS NOT DISTINCT (PostgreSQL 15+; this cluster is 16.14) makes the NULL
-- case behave the way the constraint was always meant to.
-- ---------------------------------------------------------------------------
-- The rows the bug already created violate the corrected constraint, which is
-- the constraint proving the point. They are bookkeeping, not evidence, so they
-- are deduplicated here. notice_log is append-only by trigger, so the trigger is
-- lifted for exactly this repair and restored immediately — a migration runs as
-- the owner and this is the one legitimate reason to do it.
ALTER TABLE "lotmark"."notice_log" DISABLE TRIGGER notice_log_no_delete;

DELETE FROM "lotmark"."notice_log" a
USING "lotmark"."notice_log" b
WHERE a.ctid > b.ctid
  AND a.tenant_id = b.tenant_id
  AND a.notice_kind = b.notice_kind
  AND a.subject_table = b.subject_table
  AND a.subject_id = b.subject_id
  AND a.threshold = b.threshold
  AND a.organisation_id IS NOT DISTINCT FROM b.organisation_id;

ALTER TABLE "lotmark"."notice_log" ENABLE TRIGGER notice_log_no_delete;

-- NOTE for whoever reads this during an audit: the duplicate CAPAs the bug
-- raised are NOT deleted. They are records of a finding, however spuriously
-- created, and a migration is the wrong place to dispose of a nonconformity.
-- They must be closed through the CAPA workflow with "raised in error by a
-- defect in monitoring-due, fixed in migration 0011" as the stated reason.

ALTER TABLE "lotmark"."notice_log"
  DROP CONSTRAINT notice_once_per_threshold;

ALTER TABLE "lotmark"."notice_log"
  ADD CONSTRAINT notice_once_per_threshold
  UNIQUE NULLS NOT DISTINCT
    (tenant_id, notice_kind, subject_table, subject_id, threshold, organisation_id);

-- ---------------------------------------------------------------------------
-- 2. job_runs.tenant_id was nullable, and that capability was dead.
--
-- 0004's RLS loop gave job_runs the default predicate
-- `tenant_id = current_tenant()`, so a row with NULL tenant_id can be neither
-- inserted (WITH CHECK fails) nor read. A nullable column that cannot hold NULL
-- is a trap for the next person, not a feature.
--
-- Widening the policy to `tenant_id IS NULL OR ...` would be the wrong fix: it
-- leaks one global row into every tenant's view.
-- ---------------------------------------------------------------------------
DELETE FROM "lotmark"."job_runs" WHERE tenant_id IS NULL;
ALTER TABLE "lotmark"."job_runs" ALTER COLUMN tenant_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. A notification could not be recorded for an organisation with no user.
--
-- `notifications.recipient_user_id` was NOT NULL, so notifyHolders SKIPPED any
-- holder without a named contact — on the WITHDRAWAL path — while its own
-- comment claimed the opposite and the caller went on to record "N holder(s)
-- notified" counting the ones it had silently dropped.
--
-- A withdrawal notice that reaches nobody, recorded as delivered, is precisely
-- the failure a certificate withdrawal exists to prevent.
--
-- The row is now recordable with no recipient, so the organisation appears in
-- the notification report and the producer knows to reach them another way.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."notifications"
  ALTER COLUMN recipient_user_id DROP NOT NULL;

ALTER TABLE "lotmark"."notifications"
  ADD COLUMN unreachable_reason text;

ALTER TABLE "lotmark"."notifications"
  ADD CONSTRAINT notification_states_why_it_is_unreachable CHECK (
    recipient_user_id IS NOT NULL OR unreachable_reason IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- 4. The vault half of the holder list ignored time entirely.
--
-- certificate_holders() bounded the ORDER half by the issue window and then
-- unioned every current vault holding regardless of when it was acquired, so a
-- holding acquired last week appeared as a holder of an issue from 2024.
--
-- NULL acquired_on is treated as "held since before the first issue" rather
-- than excluded: the seeded and imported holdings have no date, and excluding
-- them would silently empty the holder list on the withdrawal path — trading a
-- too-wide list for a dangerously narrow one.
-- ---------------------------------------------------------------------------
UPDATE "lotmark"."vault_holdings" v
SET acquired_on = COALESCE(
  (SELECT min(o.placed_on) FROM "lotmark"."orders" o
   JOIN "lotmark"."order_lines" ol ON ol.order_id = o.id
   WHERE o.organisation_id = v.organisation_id AND ol.lot_id = v.lot_id),
  (SELECT l.created_at::date FROM "lotmark"."lots" l WHERE l.id = v.lot_id))
WHERE v.acquired_on IS NULL;

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
    SELECT v.organisation_id, sum(v.quantity)::bigint AS quantity,
           'self-declared holding'::text AS basis, NULL::uuid AS contact_user_id
    FROM "lotmark"."vault_holdings" v
    CROSS JOIN window_bounds w
    WHERE v.lot_id = w.lot_id AND v.quantity > 0
      -- Acquired before this issue was superseded. NULL means "held since
      -- before the first issue" — see the note above.
      AND (w.to_at IS NULL OR v.acquired_on IS NULL OR v.acquired_on < w.to_at::date)
    GROUP BY v.organisation_id
  ),
  merged AS (
    SELECT * FROM from_orders UNION ALL SELECT * FROM from_vault
  )
  SELECT m.organisation_id, org.name, sum(m.quantity)::bigint,
         string_agg(DISTINCT m.basis, ' + '),
         (array_agg(m.contact_user_id) FILTER (WHERE m.contact_user_id IS NOT NULL))[1]
  FROM merged m
  JOIN "lotmark"."organisations" org ON org.id = m.organisation_id
  GROUP BY m.organisation_id, org.name;
$$;

-- ---------------------------------------------------------------------------
-- 5. 'system' must be a reserved role key.
--
-- A job attributes its ledger entries to actor_role_id = 'system'. Roles are
-- tenant configuration loaded from config_entries, so a tenant could define a
-- role keyed 'system' and make ledger attribution ambiguous — two different
-- actors indistinguishable in the one table that must never be ambiguous.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."config_entries"
  ADD CONSTRAINT config_entry_key_is_not_reserved CHECK (
    NOT (kind = 'role' AND key IN ('system', 'anonymous'))
  );
