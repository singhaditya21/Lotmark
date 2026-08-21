import type { Sql } from '../db';

/**
 * Identifier rendering, from tenant configuration.
 *
 * The template is CONFIGURATION, not code: IPC numbers materials
 * `IPRS{MAT}{SEQ}` and a generic producer uses `RMP-{MAT}-{SEQ}`. Hardcoding
 * either would make the other a fork of the product rather than a tenant of it.
 *
 * The sequence is taken under a row lock on the counter, not from `count(*)`.
 * Counting rows races: two concurrent creates read the same count and render
 * the same identifier, and the unique index then fails one of them with a
 * constraint error instead of simply giving it the next number.
 */
export interface NumberingConfig {
  readonly key: string;
  readonly entity: string;
  readonly template: string;
  readonly resetPolicy: 'never' | 'yearly' | 'per_parent';
  readonly padTo: number;
  readonly startAt: number;
}

export async function nextCode(
  tx: Sql,
  args: {
    readonly tenantId: string;
    readonly entity: string;
    /** Substituted for {MAT}; usually the material half of the SKU. */
    readonly material?: string;
    readonly today: string;
  },
): Promise<string> {
  const [cfgRow] = await tx`
    SELECT e.payload FROM lotmark.config_entries e
    JOIN lotmark.config_versions v ON v.id = e.version_id
    WHERE v.tenant_id = ${args.tenantId} AND v.status = 'active'
      AND e.kind = 'numbering' AND e.payload->>'entity' = ${args.entity}
    LIMIT 1`;
  const cfg = (cfgRow as { payload: NumberingConfig } | undefined)?.payload;
  if (!cfg) {
    throw new Error(
      `No numbering template is configured for '${args.entity}'. ` +
      'Add one to the active configuration version.',
    );
  }

  const scope = cfg.resetPolicy === 'yearly' ? args.today.slice(0, 4) : 'all';

  // Upsert-then-increment under the row lock, so two concurrent creates
  // serialise on the counter rather than colliding on the unique index.
  await tx`
    INSERT INTO lotmark.numbering_counters (tenant_id, entity, scope, next_value)
    VALUES (${args.tenantId}, ${args.entity}, ${scope}, ${cfg.startAt})
    ON CONFLICT (tenant_id, entity, scope) DO NOTHING`;

  const [row] = await tx`
    UPDATE lotmark.numbering_counters
    SET next_value = next_value + 1
    WHERE tenant_id = ${args.tenantId} AND entity = ${args.entity} AND scope = ${scope}
    RETURNING next_value - 1 AS seq`;
  const seq = Number((row as { seq: string }).seq);

  return cfg.template
    .replace('{MAT}', args.material ?? '')
    .replace('{YYYY}', args.today.slice(0, 4))
    .replace(/\{SEQ(?::(\d+))?\}/, (_m, pad) =>
      String(seq).padStart(Number(pad ?? cfg.padTo ?? 4), '0'));
}
