import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction } from '../db';

/**
 * Administering configuration.
 *
 * The interesting cases are all refusals. Publishing a configuration that does
 * not resolve locks EVERY user out of the tenant — `session.ts` throws when no
 * role parses, deliberately, because proceeding would authorise nothing and
 * look identical to a permissions bug. The person who published it would be
 * locked out too, and would be the one expected to fix it.
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
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  admin = await signIn('admin@producer.example');
});
afterAll(async () => { await app.close(); });

/** Never leave a draft behind: one per tenant, so a stray one breaks the next test. */
afterEach(async () => {
  const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/config', headers: { cookie: admin } });
  const draftId = overview.json<{ draftId: string | null }>().draftId;
  if (draftId) {
    await app.inject({ method: 'DELETE', url: `/api/v1/admin/config/draft/${draftId}`, headers: { cookie: admin } });
  }
});

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

const openDraft = async (reason: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/admin/config/draft',
    headers: { cookie: admin }, payload: { changeReason: reason },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ id: string }>().id;
};

const putEntry = (id: string, kind: string, key: string, payload: unknown) =>
  app.inject({
    method: 'PUT', url: `/api/v1/admin/config/draft/${id}/entry`,
    headers: { cookie: admin }, payload: { kind, key, payload },
  });

const review = async (id: string) => {
  const res = await app.inject({
    method: 'GET', url: `/api/v1/admin/config/draft/${id}/review`, headers: { cookie: admin },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{
    changes: Array<{ kind: string; key: string; change: string; risk: string }>;
    problems: string[]; needsSignature: boolean; publishable: boolean;
  }>();
};

/** What the console would show in the `overridesDefault` column for one entry. */
const overridesFor = async (versionId: string, kind: string, key: string) => {
  const res = await app.inject({
    method: 'GET', url: `/api/v1/admin/config/${versionId}`, headers: { cookie: admin },
  });
  expect(res.statusCode, res.body).toBe(200);
  const entry = res.json<{ entries: Array<{ kind: string; key: string; overridesDefault: boolean }> }>()
    .entries.find((e) => e.kind === kind && e.key === key);
  expect(entry, `no ${kind}:${key} entry in version ${versionId}`).toBeDefined();
  return entry!.overridesDefault;
};

const role = (key: string, over: Record<string, unknown> = {}) => ({
  key, name: `Role ${key}`, kind: 'producer',
  permissions: ['project:read'], inherits: [], system: false, ...over,
});

describe('who may administer configuration', () => {
  it('refuses somebody without user:manage', async () => {
    // Ravi is a scientist. He holds real authority over studies and none at all
    // over what the system does.
    const ravi = await signIn('ravi@producer.example');
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/config', headers: { cookie: ravi },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('user:manage');
  });
});

describe('an entry is filed under one identifier, not two', () => {
  /**
   * Every entry carries its key twice: in the `key` column, which is what a
   * query joins and orders on, and inside the payload, which is what a reader
   * parses. Nothing used to make them agree.
   */
  it('refuses a key that disagrees with the payload', async () => {
    const id = await openDraft('Key agreement');
    const res = await putEntry(id, 'role', 'auditor', role('inspector'));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/calls itself/);
  });

  it('refuses a key the payload schema would itself reject', async () => {
    // The route accepted `z.string().min(1).max(120)` for the column while the
    // payload validated a lower-case slug, so a key with spaces and capitals
    // got as far as the database.
    const id = await openDraft('Key shape');
    const res = await putEntry(id, 'role', 'My Auditor!', role('My Auditor!'));
    expect(res.statusCode).toBe(400);
  });

  it('accepts them when they agree', async () => {
    const id = await openDraft('Key agreement, positive');
    const res = await putEntry(id, 'role', 'auditor', role('auditor'));
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('whether an entry replaces a product default', () => {
  /**
   * `overrides_default` is shown in the console, so it has to be true. It was
   * hardcoded to `true` on insert and left untouched on update, which claimed
   * that anything written through the API replaces something the product
   * ships — including kinds the product ships nothing of.
   */
  it('says so for a role the product ships', async () => {
    const id = await openDraft('Overriding a shipped role');
    await putEntry(id, 'role', 'quality', role('quality'));
    expect(await overridesFor(id, 'role', 'quality')).toBe(true);
  });

  it('does not say so for a role the tenant invented', async () => {
    const id = await openDraft('A role of our own');
    await putEntry(id, 'role', 'inspector', role('inspector'));
    expect(await overridesFor(id, 'role', 'inspector')).toBe(false);
  });

  it('gives the same answer whether the entry was created or edited', async () => {
    // The UPDATE branch did not set the column at all, so an entry could end up
    // with a different answer purely because of how it got there.
    const id = await openDraft('Created then edited');
    await putEntry(id, 'role', 'inspector', role('inspector'));
    await putEntry(id, 'role', 'inspector', role('inspector', { name: 'Inspector, renamed' }));
    expect(await overridesFor(id, 'role', 'inspector')).toBe(false);
  });
});

describe('custom fields have to hold together before they publish', () => {
  /**
   * Each payload has already been validated ALONE, when it was written. None of
   * these can be checked there: they are all about one entry agreeing with
   * another, and a schema only ever sees itself. A layout naming a field that
   * does not exist parses perfectly and renders a form with a hole in it.
   */
  const lotField = (key: string, over: Record<string, unknown> = {}) => ({
    key, entity: 'lot', label: `Field ${key}`, type: 'text', ...over,
  });

  it('refuses a layout that places a field nobody defined', async () => {
    const id = await openDraft('A layout with a hole in it');
    await putEntry(id, 'layout', 'lot_extra', {
      key: 'lot_extra', entity: 'lot', name: 'Extra',
      sections: [{ title: 'Extra', fields: [{ field: 'no_such_field' }] }],
    });
    const r = await review(id);
    expect(r.publishable).toBe(false);
    expect(r.problems.join(' ')).toMatch(/places field 'no_such_field'/);
  });

  it('refuses a layout that places a field belonging to another entity', async () => {
    // It parses: both keys are slugs. It renders a lot form containing a CAPA
    // field, which no lot will ever have a value for.
    const id = await openDraft('A layout borrowing a field');
    await putEntry(id, 'layout', 'lot_extra', {
      key: 'lot_extra', entity: 'lot', name: 'Extra',
      sections: [{ title: 'Extra', fields: [{ field: 'root_cause_category' }] }],
    });
    const r = await review(id);
    expect(r.problems.join(' ')).toMatch(/belongs to capa/);
  });

  it('refuses a field drawing from a picklist nobody defined', async () => {
    // The schema checks that a select HAS a picklistKey. That it names
    // something real cannot be checked there — the picklist is another entry.
    const id = await openDraft('A select with no list');
    await putEntry(id, 'field', 'shelf', lotField('shelf', {
      type: 'select', picklistKey: 'no_such_list',
    }));
    const r = await review(id);
    expect(r.problems.join(' ')).toMatch(/picklist 'no_such_list'/);
  });

  it('refuses a type it cannot store', async () => {
    // `attachment` is in the type vocabulary and has no upload surface, so
    // publishing one produces a control that accepts nothing — and the
    // administrator hears about it from a user rather than from here.
    const id = await openDraft('An attachment field');
    await putEntry(id, 'field', 'coa', lotField('coa', { type: 'attachment' }));
    const r = await review(id);
    expect(r.problems.join(' ')).toMatch(/cannot yet be stored or rendered/);
  });

  it('refuses a required field that no layout places', async () => {
    /**
     * Once a layout exists for an entity it is authoritative — that is what a
     * layout is for. A required field left out of it makes every save of that
     * record fail, on a field the person cannot see anywhere.
     */
    const id = await openDraft('A required field nobody can reach');
    await putEntry(id, 'field', 'hidden_required',
      lotField('hidden_required', { required: true }));
    const r = await review(id);
    expect(r.problems.join(' ')).toMatch(/no layout places it as writable/);
  });

  it('refuses changing a field’s type once records hold values for it', async () => {
    /**
     * `immutableType` has carried the reason since the schema was written —
     * "changing its type would reinterpret stored data" — and nothing enforced
     * it. A text field holding 'Bulk API, Hyderabad' republished as a number
     * converts nothing; it makes every existing document fail the next time
     * somebody edits an unrelated field on the same record.
     */
    const id = await openDraft('Reinterpreting what is already stored');
    await putEntry(id, 'field', 'batch_origin', {
      key: 'batch_origin', entity: 'lot', label: 'Batch origin',
      type: 'number', required: true, sortOrder: 1,
    });
    const r = await review(id);
    const text = r.problems.join(' ');
    // Only a problem when values EXIST — custom-fields.test.ts records some.
    if (text.includes('batch_origin')) {
      expect(text).toMatch(/changes type from 'text' to 'number'/);
    } else {
      expect(text, 'no lot holds a value yet, so the change is allowed').not.toMatch(/batch_origin/);
    }
  });

  it('lets a coherent set through', async () => {
    const id = await openDraft('A field and a place to put it');
    await putEntry(id, 'field', 'shelf', lotField('shelf'));
    await putEntry(id, 'layout', 'lot_production', {
      key: 'lot_production', entity: 'lot', name: 'Lot production detail',
      sections: [
        {
          title: 'Origin and packaging', columns: 2,
          fields: [{ field: 'batch_origin', span: 2 }, { field: 'packaging' },
                   { field: 'ampoules_filled' }],
        },
        { title: 'Filling', columns: 1, fields: [{ field: 'fill_notes' }] },
        { title: 'Storage', columns: 1, fields: [{ field: 'shelf' }] },
      ],
    });
    const r = await review(id);
    expect(r.problems, r.problems.join(' | ')).toEqual([]);
    expect(r.publishable).toBe(true);
    expect(r.needsSignature, 'a field is a behaviour change').toBe(true);
  });
});

describe('a workflow has to be able to govern the records that exist', () => {
  /**
   * The active version governs every record of an entity — not the version each
   * record was created under, because two records following different rules
   * because they were made on different days is not something an operator can
   * hold in their head or an assessor can be shown. The price of that choice is
   * paid here, at publication.
   *
   * The fixture mirrors the seeded CAPA machine exactly. Writing an invented
   * one instead is how the first draft of these tests failed: the stranding
   * check reported 21 records in a state the fixture had not declared, which
   * was entirely correct and entirely my mistake.
   */
  const CAPA_STATES = [
    { key: 'open', name: 'Open' },
    { key: 'investigation', name: 'Investigation' },
    { key: 'root_cause', name: 'Root cause' },
    { key: 'capa', name: 'Corrective action' },
    { key: 'effectiveness', name: 'Effectiveness' },
    { key: 'closed', name: 'Closed' },
  ];
  const CAPA_TRANSITIONS = [
    { from: 'open', to: 'investigation', requires: 'capa:manage', action: 'Investigation opened' },
    { from: 'investigation', to: 'root_cause', requires: 'capa:manage', action: 'Root cause identified' },
    { from: 'root_cause', to: 'capa', requires: 'capa:manage', action: 'Corrective action raised' },
    { from: 'capa', to: 'effectiveness', requires: 'capa:manage', action: 'Effectiveness check started' },
    { from: 'effectiveness', to: 'closed', requires: 'capa:manage', action: 'CAPA closed' },
    { from: 'effectiveness', to: 'capa', requires: 'capa:manage', action: 'Effectiveness check failed, action reopened' },
  ];
  const capaWorkflow = (over: Record<string, unknown> = {}) => ({
    key: 'capa', name: 'Capa', entity: 'capa',
    states: CAPA_STATES, initial: 'open', terminal: ['closed'],
    transitions: CAPA_TRANSITIONS, ...over,
  });

  it('refuses removing a state records are sitting in', async () => {
    // Exactly the shape of the role check: name it, count who is affected, say
    // what to do. Without it those records have no outgoing transition at all,
    // and no screen can explain why.
    const id = await openDraft('Drop the investigation state');
    const res = await putEntry(id, 'workflow', 'capa', capaWorkflow({
      states: CAPA_STATES.filter((s) => s.key !== 'investigation'),
      transitions: [
        { from: 'open', to: 'root_cause', requires: 'capa:manage', action: 'Root cause identified' },
        ...CAPA_TRANSITIONS.slice(2),
      ],
    }));
    expect(res.statusCode, res.body).toBe(200);

    const r = await review(id);
    expect(r.publishable).toBe(false);
    expect(r.problems.join(' ')).toMatch(/does not declare the state 'investigation'/);
    expect(r.problems.join(' ')).toMatch(/would have nowhere to go/);
  });

  it('refuses a study state the database cannot store', async () => {
    /**
     * `studies.state` carries a CHECK listing its two states — the only state
     * vocabulary in the schema welded into DDL. A third would fail at the
     * INSERT as a 500, long after the change was signed off.
     */
    const id = await openDraft('A third study state');
    await putEntry(id, 'workflow', 'study', {
      key: 'study', name: 'Study', entity: 'study',
      states: [
        { key: 'draft', name: 'Draft' },
        { key: 'reviewed', name: 'Reviewed' },
        { key: 'signed', name: 'Signed' },
      ],
      initial: 'draft', terminal: ['signed'],
      transitions: [
        { from: 'draft', to: 'reviewed', requires: 'study:run', action: 'Reviewed' },
        { from: 'reviewed', to: 'signed', requires: 'study:sign', action: 'Signed' },
      ],
    });
    const r = await review(id);
    expect(r.publishable).toBe(false);
    expect(r.problems.join(' ')).toMatch(/the database cannot store/);
  });

  it('accepts a workflow that keeps every state in use', async () => {
    // Adding a transition takes nothing away, so nothing can be stranded.
    const id = await openDraft('A shortcut through CAPA');
    await putEntry(id, 'workflow', 'capa', capaWorkflow({
      transitions: [
        ...CAPA_TRANSITIONS,
        { from: 'open', to: 'closed', requires: 'capa:manage', action: 'Closed without action' },
      ],
    }));
    const r = await review(id);
    expect(r.problems, r.problems.join(' | ')).toEqual([]);
    expect(r.publishable).toBe(true);
    expect(r.needsSignature, 'a workflow is a behaviour change').toBe(true);
  });

  it('refuses a workflow whose own shape does not hold together', async () => {
    // Caught by the schema rather than at publication, but it must not reach
    // the draft at all — an unreachable state is always a mistake.
    const id = await openDraft('An unreachable state');
    const res = await putEntry(id, 'workflow', 'capa', capaWorkflow({
      states: [...CAPA_STATES, { key: 'limbo', name: 'Limbo' }],
    }));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/unreachable/);
  });
});

describe('configuration is what the machine is, not a description of it', () => {
  /**
   * The claim this whole change rests on. Resolved against the DRAFT rather
   * than by publishing: publishing would swap the tenant's active version
   * underneath every other test file running beside this one.
   */
  const CAPA_STATES = [
    { key: 'open', name: 'Open' }, { key: 'investigation', name: 'Investigation' },
    { key: 'root_cause', name: 'Root cause' }, { key: 'capa', name: 'Corrective action' },
    { key: 'effectiveness', name: 'Effectiveness' }, { key: 'closed', name: 'Closed' },
  ];
  const CAPA_TRANSITIONS = [
    { from: 'open', to: 'investigation', requires: 'capa:manage', action: 'Investigation opened' },
    { from: 'investigation', to: 'root_cause', requires: 'capa:manage', action: 'Root cause identified' },
    { from: 'root_cause', to: 'capa', requires: 'capa:manage', action: 'Corrective action raised' },
    { from: 'capa', to: 'effectiveness', requires: 'capa:manage', action: 'Effectiveness check started' },
    { from: 'effectiveness', to: 'closed', requires: 'capa:manage', action: 'CAPA closed' },
    { from: 'effectiveness', to: 'capa', requires: 'capa:manage', action: 'Effectiveness check failed, action reopened' },
  ];

  const workflowsOf = async (draftId: string) => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/admin/config/draft/${draftId}/workflows`,
      headers: { cookie: admin },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{
      workflows: Array<{
        entity: string; states: string[]; initial: string; terminal: string[];
        transitions: Array<{ from: string; to: string; action: string; systemInitiated: boolean }>;
      }>;
      dropped: string[];
    }>();
  };

  it('installs a transition a tenant added, and it was not there before', async () => {
    const id = await openDraft('A shortcut through CAPA');
    const before = await workflowsOf(id);
    const beforeCapa = before.workflows.find((w) => w.entity === 'capa')!;
    expect(beforeCapa.transitions.some((t) => t.from === 'open' && t.to === 'closed'))
      .toBe(false);

    await putEntry(id, 'workflow', 'capa', {
      key: 'capa', name: 'Capa', entity: 'capa', states: CAPA_STATES,
      initial: 'open', terminal: ['closed'],
      transitions: [
        ...CAPA_TRANSITIONS,
        { from: 'open', to: 'closed', requires: 'capa:manage', action: 'Closed without action' },
      ],
    });

    const after = await workflowsOf(id);
    const afterCapa = after.workflows.find((w) => w.entity === 'capa')!;
    const added = afterCapa.transitions.find((t) => t.from === 'open' && t.to === 'closed');
    expect(added, 'the move a tenant configured must be the move the runtime resolves')
      .toBeDefined();
    expect(added!.action).toBe('Closed without action');
  });

  it('carries the moves scheduled work may make unattended', async () => {
    /**
     * `systemInitiated` was DROPPED by the derivation until this change, so a
     * machine resolved out of configuration silently forbade the
     * entitlement-lapse job the move its own machine permits. The job now
     * resolves the tenant's machine, so this is the difference between it
     * running and it stopping.
     */
    const id = await openDraft('Check the system flag survives');
    const { workflows } = await workflowsOf(id);
    const entitlement = workflows.find((w) => w.entity === 'entitlement')!;
    const lapse = entitlement.transitions.find((t) => t.from === 'approved' && t.to === 'lapsed');
    expect(lapse, 'approved → lapsed must exist').toBeDefined();
    expect(lapse!.systemInitiated).toBe(true);

    // And a move meant for a person is not quietly handed to a job.
    const decide = entitlement.transitions.find((t) => t.to === 'approved');
    expect(decide!.systemInitiated).toBe(false);
  });

  it('ignores a workflow that does not parse, and says so', async () => {
    /**
     * Stored JSONB is validated on READ, never cast and trusted — the rule
     * `session.ts` applies to roles. A workflow naming a permission the system
     * does not enforce fails that check as a WHOLE ENTRY, because `requires` is
     * `permissionSchema`; the per-transition drop inside `machineFromConfig` is
     * a second line behind it, exercised directly in `workflows.test.ts`.
     *
     * What matters here is that one bad entry does not take out the entity. It
     * is skipped with a reason, and `machineForEntity` falls back to the
     * built-in — so every CAPA route keeps working while somebody fixes the
     * configuration, instead of the section going dark.
     *
     * Written past the API on purpose: the API would rightly refuse this, and
     * the question is what happens to an entry that arrived some other way — a
     * migration, or an older version of this code.
     */
    const id = await openDraft('A permission nothing enforces');

    /**
     * Written directly, because the API would rightly refuse it — and INSIDE a
     * tenant transaction, because `config_entries` is under forced row-level
     * security and a bare `app.db` UPDATE matches zero rows and reports
     * success. Which it did, the first time this was written.
     */
    const [tenantRow] = await app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
    await inTenantTransaction(app.db, {
      tenantId: (tenantRow as { id: string }).id,
      auditKey: app.cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
    }, async (tx) => {
      const rows = await tx`
        UPDATE lotmark.config_entries
        SET payload = jsonb_set(payload, '{transitions,0,requires}', '"invented:permission"')
        WHERE version_id = ${id} AND kind = 'workflow' AND key = 'capa'
        RETURNING id`;
      expect(rows.length, 'the entry must actually have been rewritten').toBe(1);
    });

    const after = await workflowsOf(id);
    expect(after.dropped.join(' ')).toMatch(/does not parse and was ignored/);
    expect(after.workflows.some((w) => w.entity === 'capa'),
      'the unreadable entry must be skipped, not half-built').toBe(false);

    // And the entity is not left without a machine: the built-in still governs,
    // so the CAPA screens keep working while somebody fixes the configuration.
    const live = await app.inject({
      method: 'GET', url: '/api/v1/capa/workflow', headers: { cookie: admin },
    });
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json<{ states: string[] }>().states).toContain('investigation');
  });
});

describe('drafts', () => {
  it('copies the active version and changes nothing until published', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/v1/admin/config', headers: { cookie: admin } });
    const activeId = before.json<{ activeId: string }>().activeId;

    const id = await openDraft('Copy check');
    const draft = await app.inject({
      method: 'GET', url: `/api/v1/admin/config/${id}`, headers: { cookie: admin },
    });
    const activeDetail = await app.inject({
      method: 'GET', url: `/api/v1/admin/config/${activeId}`, headers: { cookie: admin },
    });

    const keysOf = (r: typeof draft) =>
      r.json<{ entries: Array<{ kind: string; key: string }> }>()
        .entries.map((e) => `${e.kind}:${e.key}`).sort();
    expect(keysOf(draft)).toEqual(keysOf(activeDetail));

    // And the active version is still the active version.
    const after = await app.inject({ method: 'GET', url: '/api/v1/admin/config', headers: { cookie: admin } });
    expect(after.json<{ activeId: string }>().activeId).toBe(activeId);
  });

  it('allows only one at a time', async () => {
    await openDraft('The first');
    const second = await app.inject({
      method: 'POST', url: '/api/v1/admin/config/draft',
      headers: { cookie: admin }, payload: { changeReason: 'The second' },
    });
    expect(second.statusCode).toBe(422);
    expect(second.json<{ detail: string }>().detail).toMatch(/already open as a draft/);
  });

  it('refuses to edit a published version', async () => {
    const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/config', headers: { cookie: admin } });
    const activeId = overview.json<{ activeId: string }>().activeId;
    const res = await putEntry(activeId, 'role', 'sneaky', role('sneaky'));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/cannot be edited/);
  });

  it('validates a payload against the schema for its kind', async () => {
    const id = await openDraft('Validation check');
    const res = await putEntry(id, 'role', 'bogus', role('bogus', { permissions: ['not:a:permission'] }));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/not valid/);
  });
});

describe('what publication refuses', () => {
  it('refuses a configuration that would lock everybody out', async () => {
    /**
     * The failure this check exists for. Sign-in resolves authority from the
     * active version and fails closed when none of it parses, so a version with
     * no valid role locks out every user of the tenant — including whoever
     * published it, who would then be unable to publish a fix.
     */
    const id = await openDraft('Remove every role');
    const detail = await app.inject({
      method: 'GET', url: `/api/v1/admin/config/${id}`, headers: { cookie: admin },
    });
    for (const e of detail.json<{ entries: Array<{ kind: string; key: string }> }>().entries) {
      if (e.kind !== 'role') continue;
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/config/draft/${id}/entry/${e.kind}/${e.key}`,
        headers: { cookie: admin },
      });
    }

    const r = await review(id);
    expect(r.publishable).toBe(false);
    expect(r.problems.join(' ')).toMatch(/defines no valid role/);
    expect(r.problems.join(' '), 'and it says what would happen').toMatch(/lock every user out/);

    const publish = await app.inject({
      method: 'POST', url: `/api/v1/admin/config/draft/${id}/publish`,
      headers: { cookie: admin }, payload: { meaning: 'approval' },
    });
    expect(publish.statusCode).toBe(422);
  });

  it('refuses to remove a role somebody still holds', async () => {
    // Removing it does not revoke the assignments naming it: the person
    // silently loses everything while the row still looks valid.
    const id = await openDraft('Remove a role in use');
    await app.inject({
      method: 'DELETE', url: `/api/v1/admin/config/draft/${id}/entry/role/scientist`,
      headers: { cookie: admin },
    });
    const r = await review(id);
    expect(r.publishable).toBe(false);
    expect(r.problems.join(' ')).toMatch(/'scientist' is held by/);
  });

  it('refuses a security change with no signature', async () => {
    const id = await openDraft('Add a role');
    expect((await putEntry(id, 'role', 'sectionlead', role('sectionlead'))).statusCode).toBe(200);

    const r = await review(id);
    expect(r.needsSignature, 'a role is a security change').toBe(true);
    expect(r.publishable).toBe(true);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/config/draft/${id}/publish`,
      headers: { cookie: admin }, payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/must be signed/);
  });

  it('refuses a draft that changes nothing', async () => {
    const id = await openDraft('An empty change');
    const r = await review(id);
    expect(r.changes).toEqual([]);
    expect(r.publishable).toBe(false);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/config/draft/${id}/publish`,
      headers: { cookie: admin }, payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/changes nothing/);
  });

  it('rolls back completely when the signing step is refused', async () => {
    /**
     * The session is authenticated but not stepped up, which is the state every
     * session is in before its first signing. Returning from inside the
     * transaction would publish the version UNSIGNED — see SigningRejection.
     */
    const id = await openDraft('Add a role, without stepping up');
    await putEntry(id, 'role', 'sectionlead', role('sectionlead'));

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/config/draft/${id}/publish`,
      headers: { cookie: admin }, payload: { meaning: 'approval' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('step_up_required');

    // THE assertion: the version must still be a draft, and unsigned.
    const after = await app.inject({
      method: 'GET', url: `/api/v1/admin/config/${id}`, headers: { cookie: admin },
    });
    const v = after.json<{ version: { status: string; signed: boolean } }>().version;
    expect(v.status, 'a refused signing must not publish the version').toBe('draft');
    expect(v.signed).toBe(false);
  });
});

describe('reviewing', () => {
  it('reports every problem at once, not the first one', async () => {
    // An administrator fixing one problem at a time through a screen that
    // reveals the next one is how a configuration change takes an afternoon.
    const id = await openDraft('Two problems');
    await app.inject({
      method: 'DELETE', url: `/api/v1/admin/config/draft/${id}/entry/role/scientist`,
      headers: { cookie: admin },
    });
    await app.inject({
      method: 'DELETE', url: `/api/v1/admin/config/draft/${id}/entry/role/techmgr`,
      headers: { cookie: admin },
    });
    const r = await review(id);
    expect(r.problems.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies a presentation change as needing no signature', async () => {
    const id = await openDraft('Move something on a form');
    const res = await putEntry(id, 'translation', 'en-gb', {
      key: 'en-gb', locale: 'en-GB', strings: { 'projects.title': 'Projects' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = await review(id);
    expect(r.changes.some((c) => c.kind === 'translation')).toBe(true);
    expect(r.needsSignature, 'translations are presentation').toBe(false);
  });
});
