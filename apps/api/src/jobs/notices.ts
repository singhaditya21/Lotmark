import type { Sql } from '../db';
import { recordAudit } from '../services/audit';
import { machineForEntity } from '../services/workflows';
import { nextCode } from '../services/numbering';
import { assertSystemTransition } from '@lotmark/domain';
import { systemAuditContext, type TenantContext } from './context';

/**
 * Notice jobs.
 *
 * ── The property that matters is idempotency ────────────────────────────────
 *
 * A job's correctness is mostly about what happens when it runs twice. An
 * expiry notice sent every day for ninety days is not a reminder system, it is
 * a reason people filter your mail — and a filtered withdrawal notice is a
 * safety failure, not an annoyance.
 *
 * So notices fire at THRESHOLDS, and `notice_log` records
 * (kind, subject, threshold, organisation) uniquely. Re-running the job the
 * same day sends nothing; crossing the next threshold still does.
 */

/** Days before expiry at which a holder is told. Descending, so the nearest fires. */
const EXPIRY_THRESHOLDS = [90, 30, 7] as const;

export async function lotExpiryNotices(
  tx: Sql, tenant: TenantContext, auditKeyPresent = true,
): Promise<number> {
  void auditKeyPresent;
  const [today] = await tx`SELECT current_date::text AS d`;
  const d = (today as { d: string }).d;

  let sent = 0;

  for (const threshold of EXPIRY_THRESHOLDS) {
    // Lots crossing this threshold: expiring within it, but not within the next
    // (tighter) one — so each lot fires once per threshold, not once per band.
    const tighter = EXPIRY_THRESHOLDS.filter((t) => t < threshold).sort((a, b) => b - a)[0] ?? -1;

    const lots = await tx`
      SELECT l.id, l.lot_code, l.expiry_date, c.id AS certificate_id,
             (SELECT max(i.issue_number) FROM lotmark.certificate_issues i
              WHERE i.certificate_id = c.id) AS issue_number
      FROM lotmark.lots l
      JOIN lotmark.certificates c ON c.lot_id = l.id
      WHERE l.tenant_id = ${tenant.id}
        AND l.state = 'released'
        -- The ::int casts are load-bearing: postgres.js sends a JS number as an
        -- untyped parameter, and "date + unknown" is ambiguous in Postgres.
        -- (Note to the next person: no backticks in these comments. A backtick
        -- inside a SQL comment still terminates the JS template literal.)
        AND l.expiry_date <= (${d}::date + ${threshold}::int)
        AND l.expiry_date > (${d}::date + ${tighter}::int)`;

    for (const row of lots) {
      const lot = row as {
        id: string; lot_code: string; expiry_date: string;
        certificate_id: string; issue_number: number | null;
      };
      if (lot.issue_number === null) continue;

      const holders = await tx`
        SELECT * FROM lotmark.certificate_holders(${lot.certificate_id}, ${lot.issue_number})`;

      for (const h of holders) {
        const holder = h as {
          organisation_id: string; organisation_name: string; contact_user_id: string | null;
        };

        // The uniqueness constraint is the idempotency guarantee. Doing the
        // check with a SELECT first would race two workers; letting the insert
        // fail is the only version that actually holds.
        const claimed = await tx`
          INSERT INTO lotmark.notice_log
            (tenant_id, notice_kind, subject_table, subject_id, threshold, organisation_id)
          VALUES (${tenant.id}, 'lot_expiry', 'lots', ${lot.id},
                  ${String(threshold)}, ${holder.organisation_id})
          ON CONFLICT DO NOTHING
          RETURNING id`;
        if (claimed.length === 0) continue;   // already told at this threshold

        const [recipientRow] = await tx`
          SELECT id FROM lotmark.users
          WHERE tenant_id = ${tenant.id} AND organisation_id = ${holder.organisation_id}
            AND deactivated_at IS NULL
          ORDER BY created_at LIMIT 1`;
        const recipientId = holder.contact_user_id
          ?? (recipientRow as { id: string } | undefined)?.id;
        if (!recipientId) continue;

        await tx`
          INSERT INTO lotmark.notifications
            (tenant_id, recipient_user_id, subject, body, subject_table, subject_id)
          VALUES (${tenant.id}, ${recipientId},
                  ${`Lot ${lot.lot_code} expires on ${lot.expiry_date}`},
                  ${`This material expires in ${threshold} days or fewer. ` +
                    'Plan a replacement before the expiry date; a lot past expiry is no longer ' +
                    'a valid reference material.'},
                  'lot_expiry', ${lot.id})`;
        sent++;
      }
    }
  }

  if (sent > 0) {
    await recordAudit(tx, systemAuditContext({
      tenantId: tenant.id, jobName: 'lot-expiry-notices',
      timeSource: tenant.timeSource, region: tenant.region,
    }), {
      kind: 'NOTIFICATION', action: 'Lot expiry notices sent',
      detail: `${sent} notice(s) across thresholds ${EXPIRY_THRESHOLDS.join(', ')} days`,
    });
  }
  return sent;
}

/**
 * Stability monitoring that has fallen due.
 *
 * ISO 17034 7.8: a released material must keep being checked. An overdue check
 * is a finding, so it raises a CAPA rather than an email — an email is a
 * request, and a nonconformity needs a record that someone must close.
 */
export async function monitoringDue(tx: Sql, tenant: TenantContext): Promise<number> {
  const overdue = await tx`
    SELECT m.id, m.study_id, m.next_due_on, s.code AS study_code, s.owner_team_id
    FROM lotmark.monitoring_points m
    JOIN lotmark.studies s ON s.id = m.study_id
    WHERE m.tenant_id = ${tenant.id}
      AND m.next_due_on < current_date
      -- Only the latest point per study: an old overdue point whose successor
      -- exists has already been answered.
      AND m.checked_on = (
        SELECT max(m2.checked_on) FROM lotmark.monitoring_points m2
        WHERE m2.study_id = m.study_id)`;

  let raised = 0;
  for (const row of overdue) {
    const point = row as {
      id: string; study_id: string; next_due_on: string;
      study_code: string; owner_team_id: string | null;
    };

    const claimed = await tx`
      INSERT INTO lotmark.notice_log
        (tenant_id, notice_kind, subject_table, subject_id, threshold, organisation_id)
      VALUES (${tenant.id}, 'monitoring_overdue', 'monitoring_points', ${point.id},
              ${point.next_due_on}, NULL)
      ON CONFLICT DO NOTHING RETURNING id`;
    if (claimed.length === 0) continue;

    /**
     * The configured numbering counter, not `count(*)`.
     *
     * Counting rows races — two concurrent creates read the same count and
     * render the same code — and it ignores the tenant's template entirely.
     * It also reuses a code the moment a row is removed. `nextCode` takes the
     * sequence under a row lock and renders the configured template, which for
     * this tenant is NCR-{SEQ} with a yearly reset.
     */
    const code = await nextCode(tx, {
      tenantId: tenant.id, entity: 'capa', today: new Date().toISOString().slice(0, 10),
    });

    await tx`
      INSERT INTO lotmark.capa
        (tenant_id, code, source, subject_table, subject_id, severity, state,
         owner_team_id, raised_on, due_on)
      VALUES (${tenant.id}, ${code}, 'Stability monitoring overdue',
              'studies', ${point.study_id}, 'Major', 'open',
              ${point.owner_team_id}, current_date, current_date + 14)`;

    await recordAudit(tx, systemAuditContext({
      tenantId: tenant.id, jobName: 'monitoring-due',
      timeSource: tenant.timeSource, region: tenant.region,
    }), {
      kind: 'WORKFLOW', action: 'CAPA raised for overdue stability monitoring',
      detail: `${code} · ${point.study_code} · due ${point.next_due_on}`,
      subjectTable: 'capa', subjectId: point.study_id,
    });
    raised++;
  }
  return raised;
}

/**
 * Entitlements past their revalidation date.
 *
 * An approved government price tier is not permanent. Lapsing it is a state
 * change with commercial consequence, so it is audited — and it lapses rather
 * than being deleted, because the claim and its decision remain part of the record.
 */
export async function lapseEntitlements(tx: Sql, tenant: TenantContext): Promise<number> {
  /**
   * The declared machine is consulted even though no person is acting. It was
   * previously bypassed with a raw UPDATE, so a state change happened that the
   * machine said required a permission nobody had checked.
   *
   * And the machine consulted is now the TENANT'S — a tenant that removed
   * `approved → lapsed`, or that unticked "the system may make this move
   * unattended", has said this job may not run here. It stops, and says so,
   * rather than doing what the code used to say.
   */
  const machine = await machineForEntity(tx, tenant.id, 'entitlement');
  if (!machine) return 0;
  assertSystemTransition(machine, 'approved', 'lapsed');

  const lapsed = await tx`
    UPDATE lotmark.entitlements
    SET state = 'lapsed', version = version + 1
    WHERE tenant_id = ${tenant.id} AND state = 'approved'
      AND revalidation_due IS NOT NULL AND revalidation_due < current_date
    RETURNING id, code, organisation_id, revalidation_due`;

  for (const row of lapsed) {
    const e = row as { id: string; code: string; organisation_id: string; revalidation_due: string };
    await tx`
      INSERT INTO lotmark.state_transitions
        (tenant_id, subject_type, subject_id, from_state, to_state, actor_user_id, reason)
      VALUES (${tenant.id}, 'entitlement', ${e.id}, 'approved', 'lapsed', NULL,
              ${`revalidation was due ${e.revalidation_due}`})`;

    // Pricing reverts with the tier: leaving a lapsed entitlement's discount in
    // force would be the commercial half of the control quietly not applying.
    await tx`
      UPDATE lotmark.organisations SET price_tier = 'private', version = version + 1
      WHERE id = ${e.organisation_id} AND price_tier = 'government'`;

    await recordAudit(tx, systemAuditContext({
      tenantId: tenant.id, jobName: 'entitlement-revalidation',
      timeSource: tenant.timeSource, region: tenant.region,
    }), {
      kind: 'ENTITLEMENT', action: 'Tier lapsed at revalidation',
      detail: `${e.code} · revalidation due ${e.revalidation_due} · price tier reverted to private`,
      subjectTable: 'entitlements', subjectId: e.id,
    });
  }
  return lapsed.length;
}

/** Sessions past expiry or idle. Housekeeping, not evidence — no ledger entry. */
export async function pruneSessions(tx: Sql, tenant: TenantContext): Promise<number> {
  const gone = await tx`
    DELETE FROM lotmark.sessions
    WHERE tenant_id = ${tenant.id}
      AND (expires_at < now() - interval '7 days'
           OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days'))
    RETURNING id`;
  // Deliberately NOT audited. A pruned expired session is not an act anybody
  // needs to explain, and a ledger full of housekeeping hides the acts that matter.
  return gone.length;
}
