#!/usr/bin/env tsx
/**
 * The check that runs somewhere else.
 *
 * Everything else that watches this system runs INSIDE it, and therefore shares
 * its failures. The alert sweep cannot raise an alert saying the sweep is not
 * running. `/health/ready` cannot return 503 from a process that is not
 * listening. `jobStatuses` cannot report a worker that never started, because
 * the row it would report on is the row that was never written. Each of those
 * is the same shape: the component asked to report the failure is the component
 * that failed.
 *
 * So this script is deliberately small, has no dependency on the application it
 * watches, and is meant to run on a DIFFERENT machine — an ops host, a laptop
 * on a cron, a monitoring service that can run a command.
 *
 * ── Why it does not send anything ───────────────────────────────────────────
 *
 * There is no email, SMS or webhook path anywhere in this repository, and this
 * script does not add one. It exits non-zero and prints why. That is not a
 * shortcut: every operator already has something that turns a failing command
 * into a message they will see — cron's own mail, `systemd` OnFailure=, a
 * Kubernetes liveness probe, an uptime service running a shell check, Nagios,
 * Sentry crons. Building a half-implemented notifier here would compete with
 * whichever of those they already trust, and lose.
 *
 *   Exit 0  everything checked was fine.
 *   Exit 1  something is wrong and a person should look.
 *   Exit 2  the prober could not do its job — which is also worth waking for,
 *           because a check that silently stops checking is worse than none.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   PUBLIC_ORIGIN=https://certs.example.org tsx scripts/prober.mts
 *
 * With DATABASE_URL also set — as `lotmark_probe`, which is a role that can do
 * exactly one thing, see migration 0034 — it additionally answers the question
 * the application cannot answer about itself: is the thing that raises alerts
 * still running, and is anything critical open?
 */

import postgres from 'postgres';

interface Finding {
  readonly ok: boolean;
  readonly what: string;
  readonly detail: string;
}

const findings: Finding[] = [];
const ok = (what: string, detail: string) => findings.push({ ok: true, what, detail });
const bad = (what: string, detail: string) => findings.push({ ok: false, what, detail });

/** How stale the sweep stamp may be before it means the worker is gone. */
const SWEEP_STALE_MINUTES = 45;

const origin = process.env['PUBLIC_ORIGIN'] ?? process.env['PROBE_ORIGIN'];
if (!origin) {
  console.error(
    'Set PUBLIC_ORIGIN (or PROBE_ORIGIN) to the address this prober should check, ' +
    'e.g. https://certs.example.org. It must be the address as reached from ' +
    'OUTSIDE — probing localhost from the same host proves the process is up and ' +
    'nothing about whether anybody can reach it.',
  );
  process.exit(2);
}

/**
 * A timeout on every request, because the failure being probed for includes
 * "answers, eventually, in four minutes". A hung check is a check that reports
 * nothing, which is the state this script exists to prevent.
 */
async function get(path: string, timeoutMs = 10_000): Promise<{
  status: number; body: string;
} | null> {
  const abort = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(new URL(path, origin), { signal: abort });
    return { status: res.status, body: (await res.text()).slice(0, 400) };
  } catch (e) {
    /*
     * Node's own text for a refused connection is "fetch failed", which tells
     * an operator woken at 3am nothing at all. Say what was attempted.
     */
    const why = e instanceof Error ? e.message : String(e);
    bad(path,
      `could not be reached at ${new URL(path, origin).href} — ${why}. ` +
      (abort.aborted
        ? `It did not answer within ${timeoutMs / 1000}s, which for this endpoint ` +
          'means the process is wedged rather than absent.'
        : 'Nothing is listening, or something between here and there is refusing ' +
          'the connection.'));
    return null;
  }
}

/* ── Is the process there at all ─────────────────────────────────────────── */

const live = await get('/health/live');
if (live) {
  if (live.status === 200) ok('/health/live', 'the process is up');
  else bad('/health/live', `answered ${live.status}, and this endpoint checks nothing — ` +
    'a non-200 here means the process is not serving at all, or something in ' +
    'front of it is not passing traffic through.');
}

/* ── Can it serve ────────────────────────────────────────────────────────── */

const ready = await get('/health/ready');
if (ready) {
  if (ready.status === 200) ok('/health/ready', 'it can reach its database');
  else {
    bad('/health/ready',
      `answered ${ready.status}. It is running and cannot serve, so it should ` +
      `already be out of rotation. Body: ${ready.body}`);
  }
}

/* ── Is the thing that watches everything else still running ─────────────── */

const dbUrl = process.env['DATABASE_URL'];
if (!dbUrl) {
  console.log(
    'note: DATABASE_URL is not set, so the sweep-freshness and open-alert checks ' +
    'were not run. Those are the two questions the application cannot answer ' +
    'about itself. Set it to a lotmark_probe connection to include them — see ' +
    'migration 0034.',
  );
} else {
  const sql = postgres(dbUrl, { onnotice: () => {}, max: 1, connect_timeout: 10 });
  try {
    /*
     * One function, and it is the only thing this role may do.
     *
     * Reading the tables directly does not work and must not: they are under
     * FORCE row-level security, so `lotmark_app` with no tenant set sees
     * nothing. The first version of this script did read them directly and
     * reported "no tenant has ever recorded a sweep" against a database holding
     * a sweep from ninety seconds earlier and five open alerts — confidently,
     * legibly wrong, which is the worst thing a monitoring tool can be.
     *
     * Connect as `lotmark_probe`. See migration 0034 for why that is a separate
     * principal from the application.
     */
    const rows = await sql`SELECT * FROM lotmark.ops_probe_summary()` as unknown as Array<{
      tenant_id: string;
      minutes_since_sweep: number | null;
      open_alerts: number;
      critical_open: number;
    }>;

    if (rows.length === 0) {
      bad('alert sweep', 'the database holds no tenants at all.');
    }

    let watching = rows.length > 0;
    for (const r of rows) {
      const mins = r.minutes_since_sweep === null ? null : Number(r.minutes_since_sweep);
      if (mins === null) {
        watching = false;
        bad('alert sweep',
          `tenant ${r.tenant_id} has never been swept. The worker has not run, so ` +
          'nothing is watching the scheduled jobs, the retention deletions, or ' +
          'anything else — and none of it will announce itself.');
      } else if (mins > SWEEP_STALE_MINUTES) {
        watching = false;
        bad('alert sweep',
          `tenant ${r.tenant_id} last swept ${Math.round(mins)} minutes ago, and it ` +
          'runs every 15. The worker is probably not running — which means the ' +
          'absence of alerts right now means nothing at all.');
      } else {
        ok('alert sweep', `tenant ${r.tenant_id} swept ${Math.round(mins)} minute(s) ago`);
      }

      if (r.critical_open > 0) {
        /*
         * A count, not the text. The summaries name jobs, drills and tenants,
         * and an unauthenticated ops host does not need them to know somebody
         * must sign in and look.
         */
        bad(`tenant ${r.tenant_id}`,
          `${r.critical_open} critical alert(s) open, of ${r.open_alerts} total. ` +
          'Sign in to the operations screen for what they are.');
      } else if (r.open_alerts > 0) {
        ok(`tenant ${r.tenant_id}`,
          `${r.open_alerts} alert(s) open, none critical`);
      }
    }

    if (!watching) {
      /*
       * Say it plainly. An empty alert table means "nothing is wrong" only if
       * something recently looked; when the sweep is stale it means "nobody has
       * checked", and letting that read as health would be the most comfortable
       * lie this script could tell.
       */
      console.log(
        '\nnote: at least one tenant is not being swept, so a low alert count ' +
        'above is an absence of checking rather than an absence of problems.');
    }
  } catch (e) {
    bad('database', e instanceof Error ? e.message : String(e));
  } finally {
    await sql.end();
  }
}

/* ── Say what happened ───────────────────────────────────────────────────── */

for (const f of findings) {
  console.log(`  ${f.ok ? 'ok  ' : 'FAIL'}  ${f.what} — ${f.detail}`);
}

const failed = findings.filter((f) => !f.ok);
console.log(
  `\n${failed.length === 0 ? 'ALL CLEAR' : `${failed.length} PROBLEM(S)`} — ${origin}`,
);
process.exit(failed.length === 0 ? 0 : 1);
