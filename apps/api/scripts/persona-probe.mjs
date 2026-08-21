/**
 * Where does each persona actually land?
 *
 * Signs in as every seeded account and applies the SAME surface table the
 * console uses, so "does anybody land on an empty screen" is answered by
 * evidence rather than by reading the role definitions.
 *
 *   node apps/api/scripts/persona-probe.mjs
 */
import { createHmac } from 'node:crypto';

const BASE = 'http://127.0.0.1:4000/api/v1';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'demo-password-1234';

/** Mirrors apps/web/src/lib/surfaces.ts. Kept in step by this script failing loudly. */
const SURFACES = [
  { id: 'projects', label: 'Projects', half: 'producer', permission: 'project:read' },
  { id: 'capa', label: 'Complaints & CAPA', half: 'producer', permission: 'capa:manage' },
  { id: 'audit', label: 'Audit ledger', half: 'producer', permission: 'audit:read' },
];

function b32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.toUpperCase()) { const i = A.indexOf(c); if (i >= 0) bits += i.toString(2).padStart(5, '0'); }
  const o = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < o.length; i++) o[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return o;
}
function totp() {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const m = createHmac('sha1', b32(SECRET)).update(b).digest();
  const o = m[m.length - 1] & 15;
  return String(((m[o] & 127) << 24 | (m[o + 1] & 255) << 16 | (m[o + 2] & 255) << 8 | (m[o + 3] & 255)) % 1e6).padStart(6, '0');
}
function session() {
  let cookie = '';
  return async (path, init = {}) => {
    const res = await fetch(BASE + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...init.headers },
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
  };
}

const PEOPLE = [
  ['ravi@producer.example', 'RM Scientist'],
  ['sunil@producer.example', 'Production Lead'],
  ['asha@producer.example', 'Technical Manager'],
  ['neha@producer.example', 'Quality Manager'],
  ['arjun@producer.example', 'Commercial'],
  ['vikram@producer.example', 'Dispatch'],
  ['admin@producer.example', 'Tenant Admin'],
  ['meera@genpharm.example', 'Laboratory QM'],
  ['suresh@sdtl.gov.example', 'Laboratory Buyer'],
];

console.log('persona               half        lands on            sections');
console.log('─'.repeat(88));

let emptyScreens = 0;
for (const [email, role] of PEOPLE) {
  const call = session();
  const first = await call('/auth/sign-in', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  if (first.body?.secondFactorRequired) {
    await call('/auth/second-factor', { method: 'POST', body: JSON.stringify({ code: totp(), attempt: 1 }) });
  }
  const me = await call('/auth/me');
  if (me.status !== 200) { console.log(`${role.padEnd(21)} SIGN-IN FAILED ${me.status}`); continue; }

  const held = new Set([...(me.body.permissions ?? []), ...Object.values(me.body.permissionsByTeam ?? {}).flat()]);
  const kinds = me.body.roleKinds ?? [];
  const visible = SURFACES.filter((s) => kinds.includes(s.half) && (s.permission === null || held.has(s.permission)));
  const landing = visible[0]?.label ?? 'Access (explained)';

  // The defect being guarded against: a section that opens onto nothing.
  let note = '';
  if (visible.some((s) => s.id === 'projects')) {
    const projects = await call('/projects');
    const rows = projects.body?.projects?.length ?? 0;
    if (rows === 0) { note = '  ← EMPTY SCREEN'; emptyScreens++; }
  }

  console.log(
    `${role.padEnd(21)} ${kinds.join('+').padEnd(11)} ${landing.padEnd(19)} ` +
    `${visible.map((s) => s.id).join(', ') || '—'}${note}`,
  );
}

console.log('─'.repeat(88));
console.log(emptyScreens === 0
  ? 'No persona lands on a section with nothing in it.'
  : `${emptyScreens} persona(s) still land on an empty screen.`);
process.exit(emptyScreens === 0 ? 0 : 1);
