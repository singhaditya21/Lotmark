/**
 * Demonstrates segregation of duties end to end.
 *
 * The Tenant Administrator holds BOTH value:assign and value:authorise, so
 * permission alone would let them do both. SoD-1 is what stops them, and this
 * script proves it — then shows a second person completing the act legitimately.
 */
import { createHmac } from 'node:crypto';
const BASE = 'http://127.0.0.1:4000/api/v1';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'demo-password-1234';

function b32(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b='';for(const c of s.toUpperCase()){const i=A.indexOf(c);if(i<0)continue;b+=i.toString(2).padStart(5,'0')}const o=Buffer.alloc(Math.floor(b.length/8));for(let i=0;i<o.length;i++)o[i]=parseInt(b.slice(i*8,i*8+8),2);return o}
function totp(s){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const m=createHmac('sha1',b32(s)).update(b).digest();const o=m[m.length-1]&15;return String(((m[o]&127)<<24|(m[o+1]&255)<<16|(m[o+2]&255)<<8|(m[o+3]&255))%1e6).padStart(6,'0')}

function session() {
  let cookie = '';
  return async (p, o = {}) => {
    const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...o.headers } });
    const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    let b; try { b = await r.json(); } catch { b = null; }
    return { status: r.status, body: b };
  };
}

async function signInAndStepUp(email) {
  const call = session();
  await call('/auth/sign-in', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  await call('/auth/second-factor', { method: 'POST', body: JSON.stringify({ code: totp(SECRET), attempt: 1 }) });
  const su = await call('/auth/step-up', { method: 'POST', body: JSON.stringify({ password: PASSWORD, code: totp(SECRET) }) });
  return { call, steppedUp: su.status === 200 };
}

const line = (t) => console.log('\n── ' + t);
const show = (r) => console.log('  ', r.status, r.body?.detail ?? JSON.stringify(r.body).slice(0, 220));

line('Tenant Administrator signs in and steps up');
const admin = await signInAndStepUp('admin@producer.example');
console.log('   stepped up:', admin.steppedUp);

const projects = (await admin.call('/projects')).body.projects;
const prj = projects.find(p => p.code === 'PRJ-0414');
console.log('   project:', prj.code, prj.material);

line('sign the outstanding characterisation study');
const studies = (await admin.call(`/projects/${prj.id}/studies`)).body.studies;
const draft = studies.find(s => s.state === 'draft');
if (draft) {
  const r = await admin.call(`/studies/${draft.id}/sign`, { method: 'POST', body: JSON.stringify({ meaning: 'approval' }) });
  console.log('  ', draft.code, r.status, r.body?.uncertainty ?? r.body?.detail);
} else console.log('   all studies already signed');

line('ASSIGN the property value (as the administrator)');
const values = (await admin.call(`/projects/${prj.id}/values`)).body.values;
const pv = values[0];
console.log('   value:', pv.code, 'state =', pv.state);
let r = await admin.call(`/values/${pv.id}/assign`, { method: 'POST', body: JSON.stringify({ meaning: 'authorship' }) });
show(r);
if (r.body?.value) {
  console.log('   assigned value      ', r.body.value.assignedValue);
  console.log('   u_c                 ', r.body.value.combinedUncertainty);
  console.log('   U (k=' + r.body.value.coverageFactor + ')            ', r.body.value.expandedUncertainty);
}

line('the SAME person now tries to AUTHORISE it');
r = await admin.call(`/values/${pv.id}/authorise`, { method: 'POST', body: JSON.stringify({ meaning: 'approval' }) });
console.log('  ', r.status, r.body?.detail);
console.log('   ↑ the administrator holds value:authorise, and is refused anyway');

line('Dr. Asha Pillai (Technical Manager) authorises it instead');
const asha = await signInAndStepUp('asha@producer.example');
r = await asha.call(`/values/${pv.id}/authorise`, { method: 'POST', body: JSON.stringify({ meaning: 'approval' }) });
show(r);
