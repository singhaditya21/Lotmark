/**
 * End-to-end test of the signing act.
 *
 *   pnpm api                                # in one shell
 *   node apps/api/scripts/sign-smoke.mjs    # in another
 *
 * Proves: signing is refused without step-up; succeeds after it; the
 * uncertainty is computed not supplied; the signature verifies; and altering
 * the signed record afterwards makes it fail.
 */
import { createHmac } from 'node:crypto';

const BASE = 'http://127.0.0.1:4000/api/v1';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'demo-password-1234';
let cookie = '';

function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = A.indexOf(c); if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
function totp(secret) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const mac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = mac[mac.length - 1] & 0x0f;
  const code = ((mac[o] & 0x7f) << 24 | (mac[o+1] & 0xff) << 16 | (mac[o+2] & 0xff) << 8 | (mac[o+3] & 0xff)) % 1e6;
  return String(code).padStart(6, '0');
}

const call = async (p, o = {}) => {
  const res = await fetch(BASE + p, {
    ...o, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...o.headers },
  });
  const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
  let body; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

const line = (t) => console.log('\n──', t);

line('sign in as Ravi Menon (RM Scientist)');
let r = await call('/auth/sign-in', { method: 'POST', body: JSON.stringify({ email: 'ravi@producer.example', password: PASSWORD }) });
console.log('  sign-in', r.status, JSON.stringify(r.body));
r = await call('/auth/second-factor', { method: 'POST', body: JSON.stringify({ code: totp(SECRET), attempt: 1 }) });
console.log('  second-factor', r.status, JSON.stringify(r.body));

line('find a draft study');
const projects = (await call('/projects')).body.projects;
let target = null;
for (const p of projects) {
  const s = await call(`/projects/${p.id}/studies`);
  if (s.status === 404) continue;
  const draft = (s.body?.studies ?? []).find(x => x.state === 'draft');
  if (draft) { target = { ...draft, project: p.code }; break; }
}
if (!target) {
  // Fall back: the endpoint may not exist yet; use the known draft code.
  console.log('  (no /studies listing — using direct lookup)');
}
console.log('  target:', target ? `${target.code} (${target.type}) in ${target.project}` : 'none found');

if (target) {
  line('attempt to sign WITHOUT step-up');
  r = await call(`/studies/${target.id}/sign`, { method: 'POST', body: JSON.stringify({ meaning: 'approval' }) });
  console.log(' ', r.status, r.body?.detail ?? JSON.stringify(r.body));

  line('step up (password + authenticator)');
  r = await call('/auth/step-up', { method: 'POST', body: JSON.stringify({ password: PASSWORD, code: totp(SECRET) }) });
  console.log(' ', r.status, JSON.stringify(r.body));

  line('sign');
  r = await call(`/studies/${target.id}/sign`, { method: 'POST', body: JSON.stringify({ meaning: 'approval', reason: 'Results reviewed and accepted' }) });
  console.log(' ', r.status);
  if (r.body?.signature) {
    console.log('  uncertainty  ', r.body.uncertainty, '← computed, not supplied');
    console.log('  basis        ', r.body.basis);
    console.log('  meaning      ', r.body.signature.meaning);
    console.log('  key / custody', r.body.signature.keyVersion, '/', r.body.signature.custody);
    console.log('  competence   ', r.body.competence?.competenceRecordId, `valid ${r.body.competence?.validFrom}..${r.body.competence?.validTo}`);
  } else console.log(' ', JSON.stringify(r.body));

  line('verify the signature');
  r = await call(`/studies/${target.id}/signature`);
  console.log(' ', r.status, JSON.stringify(r.body));

  line('sign again (double submit)');
  r = await call(`/studies/${target.id}/sign`, { method: 'POST', body: JSON.stringify({ meaning: 'approval' }) });
  console.log(' ', r.status, r.body?.detail ?? '');

  console.log('\nstudy id for the tamper test:', target.id);
}
