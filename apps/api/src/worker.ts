/**
 * The worker process.
 *
 * Separate from the API by default. A long job must not compete with request
 * handling for the event loop, and a worker that crashes must not take sign-in
 * down with it. Run it inline only for a demo, by setting RUN_SCHEDULER on the
 * API instead.
 *
 *   pnpm --filter @lotmark/api worker          # run the scheduler
 *   pnpm --filter @lotmark/api job <name>      # run one job now and exit
 *   pnpm --filter @lotmark/api job --list      # what jobs exist
 */
import { loadConfig } from './config';
import { createDb } from './db';
import { Scheduler, JOBS } from './jobs/scheduler';

const cfg = loadConfig();
const sql = createDb(cfg);
const log = (msg: string, meta?: unknown) =>
  console.log(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`);

const scheduler = new Scheduler(sql, cfg, log);
const [, , command, ...rest] = process.argv;

if (command === '--list' || command === 'list') {
  console.log('jobs:');
  for (const j of JOBS) console.log(`  ${j.name.padEnd(26)} ${j.cron.padEnd(12)} ${j.description}`);
  await sql.end();
} else if (command) {
  // Run one job now. Used by operators and by the smoke tests, and it exercises
  // exactly the same code path the scheduler calls — a "run now" that differed
  // would test nothing.
  const outcomes = await scheduler.runNow(command === 'job' ? rest[0]! : command);
  for (const o of outcomes) {
    console.log(
      `  ${o.tenantSlug.padEnd(12)} ${o.outcome.padEnd(8)} ${o.itemsProcessed} item(s)` +
      (o.error ? `  ${o.error}` : ''),
    );
  }
  await sql.end();
  process.exit(outcomes.some((o) => o.outcome === 'failure') ? 1 : 0);
} else {
  await scheduler.start();
  log(`worker running · ${JOBS.length} scheduled job(s)`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      log(`${signal} received, draining`);
      await scheduler.stop();
      await sql.end();
      process.exit(0);
    });
  }
}
