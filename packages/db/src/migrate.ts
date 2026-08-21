/**
 * The migration runner.
 *
 * Replaces a literal `psql -f 0000 -f 0001 …` chain in package.json. That chain
 * had no record of what had been applied, so the only way to add a migration
 * was to edit the line — which is exactly how row-level security sat written
 * and unapplied without anyone noticing.
 *
 * Two properties matter more than convenience:
 *
 *  1. **It records what ran.** `schema_migrations` is the installation record.
 *     A system whose schema state cannot be asserted cannot carry an IQ record
 *     under GAMP 5, because "the software installed is the software validated"
 *     stops being a checkable claim.
 *
 *  2. **A changed migration is a HARD REFUSAL, not a warning.** If a file's
 *     checksum differs from the one recorded when it was applied, the database
 *     is not what the code thinks it is. Continuing would run later migrations
 *     against an unknown schema. It stops.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, ADMIN_URL } from './client';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '../migrations');

interface Migration {
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    // Lexical order is deliberate and depends on the zero-padded prefix.
    // A file named without one would sort unpredictably, so it is rejected.
    .sort()
    .map((filename) => {
      if (!/^\d{4}_/.test(filename)) {
        throw new Error(
          `Migration '${filename}' does not start with a four-digit prefix. ` +
          'Ordering is lexical, and an unprefixed file would apply in an unpredictable position.',
        );
      }
      const sql = readFileSync(path.join(dir, filename), 'utf8');
      return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export class MigrationError extends Error {
  constructor(message: string) { super(message); this.name = 'MigrationError'; }
}

export async function migrate(url = process.env.DATABASE_URL ?? ADMIN_URL): Promise<{
  applied: string[]; alreadyApplied: number;
}> {
  const sql = createClient(url);
  try {
    // The record lives outside the `lotmark` schema, because dropping and
    // rebuilding that schema during development must not silently erase the
    // history of what was applied to it.
    await sql`CREATE SCHEMA IF NOT EXISTS lotmark_meta`;
    await sql`
      CREATE TABLE IF NOT EXISTS lotmark_meta.schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        applied_by  text NOT NULL DEFAULT current_user,
        duration_ms integer
      )`;

    const recorded = new Map<string, string>();
    for (const r of await sql`SELECT filename, checksum FROM lotmark_meta.schema_migrations`) {
      const row = r as { filename: string; checksum: string };
      recorded.set(row.filename, row.checksum);
    }

    const migrations = loadMigrations();

    // Verify every already-applied file BEFORE running anything new. Detecting a
    // tampered migration after applying three more is not much of a detection.
    for (const m of migrations) {
      const seen = recorded.get(m.filename);
      if (seen && seen !== m.checksum) {
        throw new MigrationError(
          `Migration '${m.filename}' has changed since it was applied.\n` +
          `  recorded ${seen}\n  on disk  ${m.checksum}\n` +
          'The database is not what this code believes it is. Refusing to continue.\n' +
          'Either restore the file, or write a NEW migration that makes the change.',
        );
      }
    }
    for (const filename of recorded.keys()) {
      if (!migrations.some((m) => m.filename === filename)) {
        throw new MigrationError(
          `Migration '${filename}' was applied to this database but is missing from ${MIGRATIONS_DIR}.\n` +
          'A migration cannot be un-applied by deleting it. Refusing to continue.',
        );
      }
    }

    const applied: string[] = [];
    for (const m of migrations) {
      if (recorded.has(m.filename)) continue;
      const started = Date.now();
      // Each migration is its own transaction, so a failure leaves the
      // preceding ones applied and recorded rather than rolling back a
      // half-hour of work.
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`
          INSERT INTO lotmark_meta.schema_migrations (filename, checksum, duration_ms)
          VALUES (${m.filename}, ${m.checksum}, ${Date.now() - started})`;
      });
      applied.push(m.filename);
      process.stdout.write(`  applied ${m.filename} (${Date.now() - started} ms)\n`);
    }

    return { applied, alreadyApplied: recorded.size };
  } finally {
    await sql.end();
  }
}

/** The installation record, for an IQ pack. */
export async function schemaState(url = process.env.DATABASE_URL ?? ADMIN_URL) {
  const sql = createClient(url);
  try {
    return await sql`
      SELECT filename, checksum, applied_at, applied_by, duration_ms
      FROM lotmark_meta.schema_migrations ORDER BY filename`;
  } finally {
    await sql.end();
  }
}

/**
 * Run-as-script guard.
 *
 * Compares RESOLVED PATHS, not the URL string. `import.meta.url`
 * percent-encodes, so on a path containing a space — as this project's does —
 * `file://${process.argv[1]}` never matches and the entry point silently does
 * nothing. It exits 0, which is the worst possible way for a migration runner
 * to fail.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const cmd = process.argv[2] ?? 'up';
  if (cmd === 'status') {
    const rows = await schemaState();
    console.log(`${rows.length} migration(s) applied:`);
    for (const r of rows) {
      const m = r as { filename: string; applied_at: string; duration_ms: number | null };
      console.log(`  ${m.filename.padEnd(34)} ${m.applied_at} ${m.duration_ms ?? '—'} ms`);
    }
  } else {
    console.log('migrating…');
    const { applied, alreadyApplied } = await migrate();
    console.log(applied.length === 0
      ? `up to date — ${alreadyApplied} migration(s) already applied`
      : `applied ${applied.length} migration(s); ${alreadyApplied} were already in place`);
  }
}
