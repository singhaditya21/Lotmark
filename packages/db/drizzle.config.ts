import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/lotmark_dev',
  },
  // Every migration is reviewed by hand: this schema carries append-only
  // triggers, row-level security policies and exclusion constraints that a
  // generator cannot infer.
  verbose: true,
  strict: true,
} satisfies Config;
