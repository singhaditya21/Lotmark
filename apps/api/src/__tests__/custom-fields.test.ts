import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction, type Sql } from '../db';

/**
 * Custom fields at runtime — the form designer's other half.
 *
 * The configuration model has been able to DESCRIBE fields since it was
 * written, and until now nothing read one. These are the claims that matter
 * once something does: that what a tenant defined is what gets enforced, that a
 * value cannot be quietly replaced, and that a document nothing configured
 * cannot be stored.
 *
 * The definitions come from the SEEDED configuration rather than being
 * published here. Publishing mid-suite would open a draft, and there is one
 * draft per tenant — so this file and config-admin.test.ts would fight over it
 * whenever vitest ran them together.
 */

const PASSWORD = 'demo-password-1234';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.toUpperCase()) {
    const i = alphabet.indexOf(ch);
    if (i >= 0) bits += i.toString(2).padStart(5, '0');
  }
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
function currentTotp(): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const mac = createHmac('sha1', base32(TOTP_SECRET)).update(counter).digest();
  const o = mac[mac.length - 1]! & 15;
  const code = ((mac[o]! & 127) << 24) | ((mac[o + 1]! & 255) << 16)
    | ((mac[o + 2]! & 255) << 8) | (mac[o + 3]! & 255);
  return String(code % 1_000_000).padStart(6, '0');
}

let app: FastifyInstance;
/** Sunil is production lead: holds lot:create, which governs a lot's fields. */
let sunil: string;
/** Ravi is a scientist: project:read but not lot:create — may look, not touch. */
let ravi: string;
/** A live lot in Sunil's section, and a superseded one in the same section. */
let lotId: string;
let supersededLotId: string;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  sunil = await signIn('sunil@producer.example');
  ravi = await signIn('ravi@producer.example');
  ({ lotId, supersededLotId } = await lotsInSunilsSection());
});
afterAll(async () => { await app.close(); });

async function signIn(email: string): Promise<string> {
  const first = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in', payload: { email, password: PASSWORD },
  });
  const raw = first.headers['set-cookie'];
  let cookie = (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0]!;
  if (first.json<{ secondFactorRequired?: boolean }>().secondFactorRequired) {
    const second = await app.inject({
      method: 'POST', url: '/api/v1/auth/second-factor',
      headers: { cookie }, payload: { code: currentTotp(), attempt: 1 },
    });
    expect(second.statusCode, second.body).toBe(200);
    const rotated = second.headers['set-cookie'];
    if (rotated) cookie = (Array.isArray(rotated) ? rotated[0]! : String(rotated)).split(';')[0]!;
  }
  return cookie;
}

function asTenant<T>(fn: (tx: Sql, tenantId: string) => Promise<T>): Promise<T> {
  return app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`.then(([t]) => {
    const tenantId = (t as { id: string }).id;
    return inTenantTransaction(app.db, {
      tenantId, auditKey: app.cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
      organisationKind: 'producer',
    }, (tx) => fn(tx, tenantId));
  });
}

/**
 * Lots belonging to the team Sunil actually leads.
 *
 * Not "the first lot": authority here is SCOPED, and Sunil holds `prodlead` on
 * Organics Section and nowhere else. A test that grabbed any lot would have
 * been refused on an Inorganics one — correctly — and would have looked like a
 * bug in the feature rather than a bug in the test. Which is what happened.
 */
const lotsInSunilsSection = () => asTenant(async (tx) => {
  const rows = await tx`
    SELECT l.id, l.state
    FROM lotmark.lots l
    JOIN lotmark.projects p ON p.id = l.project_id
    JOIN lotmark.teams t ON t.id = p.owner_team_id
    JOIN lotmark.role_assignments ra ON ra.team_id = t.id AND ra.revoked_at IS NULL
    JOIN lotmark.users u ON u.id = ra.user_id
    WHERE u.email = 'sunil@producer.example' AND ra.role_key = 'prodlead'
    ORDER BY l.lot_code`;
  const all = [...rows] as Array<{ id: string; state: string }>;
  const live = all.find((l) => l.state !== 'superseded' && l.state !== 'withdrawn');
  const dead = all.find((l) => l.state === 'superseded' || l.state === 'withdrawn');
  expect(live, 'the seed must leave Sunil a lot he can still edit').toBeDefined();
  expect(dead, 'and one that has been superseded').toBeDefined();
  return { lotId: live!.id, supersededLotId: dead!.id };
});

const readForm = (cookie: string, entity = 'lot'): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'GET', url: `/api/v1/custom-fields/${entity}`, headers: { cookie } });

const readRecord = (cookie: string, id = lotId, entity = 'lot'): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'GET', url: `/api/v1/custom-fields/${entity}/${id}`, headers: { cookie } });

const save = (
  cookie: string, body: Record<string, unknown>, id = lotId, entity = 'lot',
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'PUT', url: `/api/v1/custom-fields/${entity}/${id}`,
    headers: { cookie }, payload: body,
  });

/** Save whatever is valid right now, returning the new revision. */
async function saveGood(over: Record<string, unknown> = {}): Promise<number> {
  const before = await readRecord(sunil);
  const revision = before.json<{ revision: number }>().revision;
  const res = await save(sunil, {
    basedOnRevision: revision,
    values: {
      batch_origin: 'Bulk API, Hyderabad',
      packaging: 'ampoule_2ml',
      ampoules_filled: 500,
      fill_notes: 'Filled over two sessions.',
      ...over,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ revision: number }>().revision;
}

describe('the form a tenant defined is the form that is served', () => {
  it('describes the seeded lot layout, in its configured order', async () => {
    const res = await readForm(sunil);
    expect(res.statusCode, res.body).toBe(200);
    const form = res.json<{
      form: {
        layoutKey: string | null;
        sections: Array<{ title: string; fields: Array<{ field: { key: string; type: string } }> }>;
        picklists: Record<string, Array<{ value: string; retired: boolean }>>;
      };
    }>().form;

    expect(form.layoutKey).toBe('lot_production');
    expect(form.sections.map((s) => s.title))
      .toEqual(['Origin and packaging', 'Filling']);
    expect(form.sections[0]!.fields.map((f) => f.field.key))
      .toEqual(['batch_origin', 'packaging', 'ampoules_filled']);
  });

  it('sends the option list the fields draw from, retired values marked', async () => {
    /**
     * Marked, not withheld. A lot may already hold a retired value, and the
     * renderer needs its LABEL to show it — a form that renders a stored value
     * as a blank select is how somebody re-saves a record and loses it.
     */
    const form = (await readForm(sunil)).json<{
      form: { picklists: Record<string, Array<{ value: string; retired: boolean }>> };
    }>().form;
    const packaging = form.picklists['packaging']!;
    expect(packaging.map((v) => v.value)).toContain('bottle_50ml');
    expect(packaging.find((v) => v.value === 'bottle_50ml')!.retired).toBe(true);
    expect(packaging.find((v) => v.value === 'ampoule_2ml')!.retired).toBe(false);
  });

  it('sends no picklist a form does not use', async () => {
    // root_cause belongs to capa. Shipping every list to every form leaks the
    // shape of screens the viewer may not be allowed to see.
    const form = (await readForm(sunil)).json<{ form: { picklists: Record<string, unknown> } }>().form;
    expect(Object.keys(form.picklists)).toEqual(['packaging']);
  });

  it('has nothing to show for an entity nobody configured', async () => {
    const form = (await readForm(sunil, 'project')).json<{
      form: { sections: unknown[]; layoutKey: string | null };
    }>().form;
    expect(form.sections).toEqual([]);
    expect(form.layoutKey).toBeNull();
  });

  it('refuses a record type that cannot carry custom fields at all', async () => {
    const res = await readForm(sunil, 'widgets');
    expect(res.statusCode).toBe(404);
  });
});

describe('who may read and who may write', () => {
  it('lets a scientist read a lot’s fields', async () => {
    // Reading a lot is project:read, which Ravi holds.
    expect((await readRecord(ravi)).statusCode).toBe(200);
  });

  it('refuses that scientist the write', async () => {
    /**
     * Writing a lot's custom fields is lot:create — the permission that already
     * governs a lot. There is deliberately no `customfield:write`: it would let
     * somebody who cannot edit a lot change what a lot says, and being new it
     * would be held by nobody in any tenant that already exists.
     */
    const res = await save(ravi, { basedOnRevision: 0, values: { batch_origin: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('what may be stored', () => {
  it('records a document and reads it back', async () => {
    const revision = await saveGood();
    const res = await readRecord(sunil);
    const body = res.json<{ values: Record<string, unknown>; revision: number; recordedBy: string }>();
    expect(body.revision).toBe(revision);
    expect(body.values['batch_origin']).toBe('Bulk API, Hyderabad');
    expect(body.values['ampoules_filled']).toBe(500);
    expect(body.recordedBy).toBe('Sunil Bhatt');
  });

  it('enforces the type the tenant chose, not a type the client sent', async () => {
    const before = (await readRecord(sunil)).json<{ revision: number }>().revision;
    const res = await save(sunil, {
      basedOnRevision: before,
      values: { batch_origin: 'Pune', packaging: 'ampoule_2ml', ampoules_filled: 'many' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/ampoules_filled/);
  });

  it('enforces the range the tenant chose', async () => {
    const before = (await readRecord(sunil)).json<{ revision: number }>().revision;
    const res = await save(sunil, {
      basedOnRevision: before,
      values: { batch_origin: 'Pune', packaging: 'ampoule_2ml', ampoules_filled: 0 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('holds a select to its picklist', async () => {
    const before = (await readRecord(sunil)).json<{ revision: number }>().revision;
    const res = await save(sunil, {
      basedOnRevision: before,
      values: { batch_origin: 'Pune', packaging: 'cardboard_box' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/packaging/);
  });

  it('refuses a required field left empty', async () => {
    const before = (await readRecord(sunil)).json<{ revision: number }>().revision;
    const res = await save(sunil, {
      basedOnRevision: before,
      values: { batch_origin: '', packaging: 'ampoule_2ml' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('refuses a key no field defines', async () => {
    /**
     * Not ignored — refused. Ignoring it stores a document that accumulates
     * data no screen shows and no rule governs, and tells the person who sent
     * it that it worked.
     */
    const before = (await readRecord(sunil)).json<{ revision: number }>().revision;
    const res = await save(sunil, {
      basedOnRevision: before,
      values: { batch_origin: 'Pune', packaging: 'ampoule_2ml', smuggled: 'x' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/smuggled/);
  });

  it('refuses a record that does not exist in this tenant', async () => {
    // Otherwise values attach to any uuid at all: rows no screen shows, no
    // parent can delete, and every count in the assessment pack quietly wrong.
    const res = await save(sunil, {
      basedOnRevision: 0, values: { batch_origin: 'x', packaging: 'ampoule_2ml' },
    }, '00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });
});

describe('a value cannot be quietly replaced', () => {
  it('appends a revision rather than editing one', async () => {
    const first = await saveGood({ batch_origin: 'First origin' });
    const second = await saveGood({ batch_origin: 'Second origin' });
    expect(second).toBe(first + 1);

    const res = await app.inject({
      method: 'GET', url: `/api/v1/custom-fields/lot/${lotId}/history`, headers: { cookie: sunil },
    });
    const revisions = res.json<{
      revisions: Array<{ revision: number; values: Record<string, unknown>; recordedByName: string }>;
    }>().revisions;

    const a = revisions.find((r) => r.revision === first)!;
    const b = revisions.find((r) => r.revision === second)!;
    // 21 CFR 11 §11.10(e): the change must not obscure what it replaced.
    expect(a.values['batch_origin']).toBe('First origin');
    expect(b.values['batch_origin']).toBe('Second origin');
  });

  it('refuses a save based on a revision somebody else has moved past', async () => {
    const stale = (await readRecord(sunil)).json<{ revision: number }>().revision;
    await saveGood({ batch_origin: 'Won the race' });

    const res = await save(sunil, {
      basedOnRevision: stale,
      values: { batch_origin: 'Lost the race', packaging: 'ampoule_2ml' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/Somebody else saved/);
  });

  it('stamps each revision with the configuration that validated IT', async () => {
    // Never restamped. It is what keeps an old revision explicable once the
    // definitions have moved on.
    await saveGood();
    const rows = await asTenant(async (tx) => {
      const r = await tx`
        SELECT revision, config_version_id FROM lotmark.custom_field_values
        WHERE entity = 'lot' AND record_id = ${lotId} ORDER BY revision`;
      return [...r];
    });
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) {
      expect((r as { config_version_id: string | null }).config_version_id).toBeTruthy();
    }
  });

  it('cannot be updated or deleted, at the database', async () => {
    /**
     * Two layers, and this proves the one a comment cannot: the application
     * role holds only INSERT and SELECT, and the trigger refuses besides. 0019
     * recorded what happens when only the comment is there.
     */
    await expect(asTenant(async (tx) => {
      await tx`UPDATE lotmark.custom_field_values SET "values" = '{}'::jsonb
               WHERE entity = 'lot' AND record_id = ${lotId}`;
    })).rejects.toThrow();

    await expect(asTenant(async (tx) => {
      await tx`DELETE FROM lotmark.custom_field_values
               WHERE entity = 'lot' AND record_id = ${lotId}`;
    })).rejects.toThrow();
  });

  it('refuses a record that has reached a terminal state', async () => {
    /**
     * Append-only keeps the HISTORY of a change; it does not stop the change.
     * A superseded lot whose custom fields can still be edited is a record
     * whose meaning moves after it was retired — and `field.onCertificate`
     * makes that concrete, because a value printed on an issued certificate
     * must not acquire a successor.
     *
     * The frozen states are derived from each machine's `terminal` array, so
     * this cannot drift from the workflow the product actually runs.
     */
    const res = await save(sunil, {
      basedOnRevision: 0,
      values: { batch_origin: 'Too late', packaging: 'ampoule_2ml' },
    }, supersededLotId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/superseded/);
  });

  it('still lets that record be READ', async () => {
    // Frozen is not hidden. The values are part of the record and stay legible;
    // the response says so, so the console can render read-only rather than
    // let somebody type and be refused on submit.
    const res = await readRecord(sunil, supersededLotId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ frozen: boolean; parentState: string }>().frozen).toBe(true);
    expect(res.json<{ parentState: string }>().parentState).toBe('superseded');
  });

  it('records the act in the ledger, against the parent record', async () => {
    // An assessor reads the ledger by subject. "What happened to this lot" has
    // to include what its custom fields say.
    const revision = await saveGood();
    const rows = await asTenant(async (tx) => {
      const r = await tx`
        SELECT action, detail, changes FROM lotmark.audit_ledger
        WHERE subject_table = 'lot' AND subject_id = ${lotId}
        ORDER BY seq DESC LIMIT 1`;
      return [...r];
    });
    const entry = rows[0] as { action: string; detail: string; changes: unknown };
    expect(entry.action).toBe('Custom fields recorded');
    expect(entry.detail).toContain(`revision ${revision}`);
    // The keys touched, never the values: the ledger says an act happened, and
    // the append-only revision is where the content lives.
    expect(JSON.stringify(entry.changes)).not.toContain('Bulk API');
  });
});
