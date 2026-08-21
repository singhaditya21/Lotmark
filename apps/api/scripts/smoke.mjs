/**
 * End-to-end smoke test against a running API.
 *
 *   pnpm --filter @lotmark/api start        # in one shell
 *   node apps/api/scripts/smoke.mjs [email] # in another
 *
 * Drives the real flow: password, second factor, session cookie, team-scoped
 * project list, a recomputed uncertainty budget, and a chain verification.
 */
import { createHmac } from 'node:crypto';

/**
 * TOTP (RFC 6238) inline, so this script has no dependencies and can be run
 * with a bare `node` from anywhere in the repo.
 */
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = A.indexOf(c);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

function totp(secret, step = 30, digits = 6) {
  const counter = Math.floor(Date.now() / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24 | (mac[offset + 1] & 0xff) << 16
             | (mac[offset + 2] & 0xff) << 8 | (mac[offset + 3] & 0xff)) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
const BASE = 'http://127.0.0.1:4000/api/v1';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let cookie = '';

const call = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...opts.headers },
  });
  const setC = res.headers.get('set-cookie');
  if (setC) cookie = setC.split(';')[0];
  let body; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

const who = process.argv[2] ?? 'ravi@producer.example';
console.log(`\n=== signing in as ${who} ===`);
let r = await call('/auth/sign-in', { method: 'POST', body: JSON.stringify({ email: who, password: 'demo-password-1234' }) });
console.log('sign-in     ', r.status, JSON.stringify(r.body));

if (r.body?.secondFactorRequired) {
  r = await call('/auth/second-factor', { method: 'POST', body: JSON.stringify({ code: totp(SECRET), attempt: 1 }) });
  console.log('second-factor', r.status, JSON.stringify(r.body));
}

r = await call('/auth/me');
console.log('me          ', r.status);
if (r.body?.user) {
  console.log('  user      ', r.body.user.name);
  console.log('  teams     ', r.body.teams.map(t => t.key).join(', ') || '(none)');
  console.log('  tenant-wide perms:', r.body.permissions.length);
  for (const [team, perms] of Object.entries(r.body.permissionsByTeam ?? {})) {
    console.log(`  team ${team.slice(0,8)}…: ${perms.length} perms`);
  }
}

r = await call('/projects');
console.log('projects    ', r.status, 'scope=' + r.body?.scope);
for (const p of r.body?.projects ?? []) console.log(`  ${p.code}  ${p.material.padEnd(26)} ${p.team ?? '—'}`);

if (r.body?.projects?.length) {
  const first = r.body.projects.find(p => p.code === 'PRJ-0412') ?? r.body.projects[0];
  const b = await call(`/projects/${first.id}/budget`);
  console.log(`budget ${first.code}`, b.status);
  if (b.body?.budget) {
    console.log('  assigned value  ', b.body.assignedValue);
    console.log('  u(bb)/u(lts)/u(char)', b.body.budget.uBb, b.body.budget.uLts, b.body.budget.uChar);
    console.log('  u_c             ', b.body.budget.uCombined);
    console.log('  U (k=2)         ', b.body.budget.expanded);
    for (const c of b.body.components) console.log(`    ${c.symbol.padEnd(9)} ${c.value.toFixed(6)}  ${c.basis}`);
  } else console.log('  ', JSON.stringify(b.body));
}

const v = await call('/audit/verify', { method: 'POST', body: '{}' });
console.log('chain verify', v.status, JSON.stringify(v.body));
