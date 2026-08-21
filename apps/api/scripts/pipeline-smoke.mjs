/**
 * The whole vertical slice, end to end:
 *
 *   sign a study → assign a value → authorise it (a different person)
 *   → release a lot → issue a certificate → verify the chain
 *
 * Every act is signed, guarded, and appended to the ledger.
 */
import { createHmac } from 'node:crypto';
const BASE = 'http://127.0.0.1:4000/api/v1';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'demo-password-1234';

function b32(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b='';for(const c of s.toUpperCase()){const i=A.indexOf(c);if(i<0)continue;b+=i.toString(2).padStart(5,'0')}const o=Buffer.alloc(Math.floor(b.length/8));for(let i=0;i<o.length;i++)o[i]=parseInt(b.slice(i*8,i*8+8),2);return o}
function totp(s){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const m=createHmac('sha1',b32(s)).update(b).digest();const o=m[m.length-1]&15;return String(((m[o]&127)<<24|(m[o+1]&255)<<16|(m[o+2]&255)<<8|(m[o+3]&255))%1e6).padStart(6,'0')}
function session(){let c='';return async(p,o={})=>{const r=await fetch(BASE+p,{...o,headers:{'content-type':'application/json',...(c?{cookie:c}:{}),...o.headers}});const k=r.headers.get('set-cookie');if(k)c=k.split(';')[0];let b;try{b=await r.json()}catch{b=null}return{status:r.status,body:b}}}
async function actor(email){const call=session();await call('/auth/sign-in',{method:'POST',body:JSON.stringify({email,password:PASSWORD})});await call('/auth/second-factor',{method:'POST',body:JSON.stringify({code:totp(SECRET),attempt:1})});await call('/auth/step-up',{method:'POST',body:JSON.stringify({password:PASSWORD,code:totp(SECRET)})});return call}
const step=(n,t)=>console.log(`\n${n}. ${t}`);
const ok=(r)=>r.status>=200&&r.status<300;

const admin = await actor('admin@producer.example');
const asha  = await actor('asha@producer.example');

const projects = (await admin('/projects')).body.projects;
const prj = projects.find(p => p.code === 'PRJ-0414');
console.log(`Project ${prj.code} — ${prj.material} (${prj.team})`);

step(1, 'sign the outstanding characterisation study');
const studies = (await admin(`/projects/${prj.id}/studies`)).body.studies;
const draft = studies.find(s => s.state === 'draft');
let r = await admin(`/studies/${draft.id}/sign`, { method: 'POST', body: JSON.stringify({ meaning: 'approval' }) });
console.log(`   ${draft.code}  ${r.status}  u = ${r.body?.uncertainty}`);
console.log(`   ${r.body?.basis}`);

step(2, 'assign the property value');
const pv = (await admin(`/projects/${prj.id}/values`)).body.values[0];
r = await admin(`/values/${pv.id}/assign`, { method: 'POST', body: JSON.stringify({ meaning: 'authorship' }) });
console.log(`   ${pv.code}  ${r.status}  ${r.body?.value?.assignedValue} ± ${r.body?.value?.expandedUncertainty?.toPrecision(4)} ${r.body?.value?.unit}`);
for (const c of r.body?.components ?? []) console.log(`     ${c.symbol.padEnd(9)} ${c.value.toFixed(6)}  ${c.basis}`);

step(3, 'the assigner tries to authorise — SoD');
r = await admin(`/values/${pv.id}/authorise`, { method: 'POST', body: JSON.stringify({ meaning: 'approval' }) });
console.log(`   ${r.status}  ${r.body?.detail}`);

step(4, 'Dr. Asha Pillai authorises');
r = await asha(`/values/${pv.id}/authorise`, { method: 'POST', body: JSON.stringify({ meaning: 'approval' }) });
console.log(`   ${r.status}  state = ${r.body?.value?.state}`);

step(5, 'release a lot');
r = await asha(`/projects/${prj.id}/release-lot`, { method: 'POST', body: JSON.stringify({
  meaning: 'responsibility', expiryDate: '2029-03-31', stockUnits: 60, unitPriceMinor: 550000,
}) });
console.log(`   ${r.status}  ${r.body?.lot?.lotCode}  expires ${r.body?.lot?.expiryDate}`);
console.log(`   storage ${r.body?.lot?.storageCondition}  cold chain: ${r.body?.lot?.coldChain}`);
const lotId = r.body?.lot?.id;

step(6, 'issue the certificate');
r = await asha(`/lots/${lotId}/certificate`, { method: 'POST', body: JSON.stringify({ meaning: 'approval' }) });
if (ok(r)) {
  console.log(`   ${r.status}  ${r.body.certificate.code} issue #${r.body.issue.number} for ${r.body.certificate.lot}`);
  console.log(`   ${r.body.issue.property}: ${r.body.issue.assignedValue} ± ${r.body.issue.expandedUncertainty.toPrecision(4)} ${r.body.issue.unit} (k=${r.body.issue.coverageFactor})`);
} else console.log(`   ${r.status}  ${r.body?.detail}`);

step(7, 'verify the audit chain');
const neha = await actor('neha@producer.example');
r = await neha('/audit/verify', { method: 'POST', body: '{}' });
console.log(`   ${r.status}  ${JSON.stringify(r.body)}`);

step(8, 'the ledger for this run');
const entries = (await neha('/audit?limit=12')).body.entries ?? [];
for (const e of entries.slice(0, 10).reverse()) {
  console.log(`   #${String(e.seq).padStart(2)} ${e.kind.padEnd(12)} ${e.action}`);
}
