/**
 * Can a user actually USE this system?
 *
 * Builds a reference material from nothing — no seed data touched. Creates a
 * project, three studies, records real measurements into each, signs them,
 * creates and assigns a property value, has a second person authorise it,
 * releases a lot and issues a certificate.
 *
 * If this passes, Lotmark is a system. If it does not, it is a demonstration.
 */
import { createHmac } from 'node:crypto';
const BASE = 'http://127.0.0.1:4000/api/v1';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'demo-password-1234';

function b32(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b='';for(const c of s.toUpperCase()){const i=A.indexOf(c);if(i<0)continue;b+=i.toString(2).padStart(5,'0')}const o=Buffer.alloc(Math.floor(b.length/8));for(let i=0;i<o.length;i++)o[i]=parseInt(b.slice(i*8,i*8+8),2);return o}
function totp(s){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const m=createHmac('sha1',b32(s)).update(b).digest();const o=m[m.length-1]&15;return String(((m[o]&127)<<24|(m[o+1]&255)<<16|(m[o+2]&255)<<8|(m[o+3]&255))%1e6).padStart(6,'0')}
function session(){let c='';return async(p,o={})=>{const r=await fetch(BASE+p,{...o,headers:{'content-type':'application/json',...(c?{cookie:c}:{}),...o.headers}});const k=r.headers.get('set-cookie');if(k)c=k.split(';')[0];let b;try{b=await r.json()}catch{b=null}return{status:r.status,body:b}}}
async function actor(email){const call=session();await call('/auth/sign-in',{method:'POST',body:JSON.stringify({email,password:PASSWORD})});await call('/auth/second-factor',{method:'POST',body:JSON.stringify({code:totp(SECRET),attempt:1})});await call('/auth/step-up',{method:'POST',body:JSON.stringify({password:PASSWORD,code:totp(SECRET)})});return call}

const step = (n, t) => console.log(`\n${n}. ${t}`);
const bad  = (r) => `${r.status} ${r.body?.detail ?? JSON.stringify(r.body).slice(0,140)}`;

// Each act is performed by whoever legitimately holds it. Using one
// all-powerful account would prove nothing about the authorisation model.
const sunil = await actor('sunil@producer.example');  // Production Lead — project:manage
const ravi  = await actor('ravi@producer.example');   // RM Scientist   — study:run, study:sign, value:assign
const asha  = await actor('asha@producer.example');   // Technical Mgr  — value:authorise, lot:release, cert:issue

step(1, 'create a project — nothing seeded');
const teams = (await sunil('/teams')).body.teams;
let r = await sunil('/projects', { method:'POST', body: JSON.stringify({
  materialName: 'Caffeine', casNumber: '58-08-2', sku: 'RM-CAFF',
  intakeQuantity: '100 mg', targetUncertainty: '0.4%',
  teamId: teams.find(t => t.key === 'organics')?.id ?? teams[0].id,
})});
if (r.status !== 201) { console.log('  ', bad(r)); process.exit(1); }
const prj = r.body.project;
console.log(`   ${prj.code}  Caffeine  stage=${prj.stage}`);

step(2, 'create three studies');
const equipment = (await sunil('/equipment')).body.equipment;
const eq = (code) => equipment.find(e => e.code === code).id;
const studies = {};
for (const [type, ids, extra] of [
  ['homogeneity',      [eq('EQ-01'), eq('EQ-02')], {}],
  ['stability',        [eq('EQ-04')],              { shelfLifeTo:'2029-06-30', storageCondition:'2–8 °C', transportCondition:'Chilled 72 h' }],
  ['characterisation', [eq('EQ-01')],              {}],
]) {
  r = await sunil(`/projects/${prj.id}/studies`, { method:'POST', body: JSON.stringify({ studyType:type, equipmentIds:ids, ...extra })});
  if (r.status !== 201) { console.log(`   ${type}:`, bad(r)); process.exit(1); }
  studies[type] = r.body.study;
  console.log(`   ${r.body.study.code.padEnd(8)} ${type}`);
}

step(3, 'reject a measurement of the wrong shape');
r = await ravi(`/studies/${studies.homogeneity.id}/results`, { method:'PUT', body: JSON.stringify({
  measurements: [{ value: 99.5 }],   // no unit, no replicate
})});
console.log(`   ${r.status}  ${r.body?.detail}`);

step(4, 'record real measurements');
const homog = [];
for (const [i, u] of [4,21,38,55,72,89].entries())
  for (const rep of [1,2]) homog.push({ unit:u, replicate:rep, value: 99.55 + (i-2.5)*0.04 + (rep-1.5)*0.05 });
r = await ravi(`/studies/${studies.homogeneity.id}/results`, { method:'PUT', body: JSON.stringify({ measurements: homog })});
console.log(`   homogeneity     ${r.status}  ${r.body?.recorded} measurements`);

r = await ravi(`/studies/${studies.stability.id}/results`, { method:'PUT', body: JSON.stringify({
  measurements: [0,1,3,6,12,24].map((m,i) => ({ elapsedMonths:m, value: 99.60 - m*0.004 + (i%2?0.02:-0.02) })),
})});
console.log(`   stability       ${r.status}  ${r.body?.recorded} measurements`);

r = await ravi(`/studies/${studies.characterisation.id}/results`, { method:'PUT', body: JSON.stringify({
  measurements: [['L1',99.61],['L2',99.74],['L3',99.48],['L4',99.66],['L5',99.55]].map(([lab,v]) => ({ laboratory:lab, value:v })),
})});
console.log(`   characterisation ${r.status}  ${r.body?.recorded} measurements`);

step(5, 'sign all three studies');
for (const t of ['homogeneity','stability','characterisation']) {
  r = await ravi(`/studies/${studies[t].id}/sign`, { method:'POST', body: JSON.stringify({ meaning:'approval', reason:'Results reviewed' })});
  console.log(`   ${studies[t].code.padEnd(8)} ${r.status}  u = ${r.body?.uncertainty ?? r.body?.detail}`);
}

step(6, 'create and assign the property value');
r = await ravi(`/projects/${prj.id}/values`, { method:'POST', body: JSON.stringify({ propertyName:'Assay (as is)', unit:'% w/w', coverageFactor:2 })});
const pv = r.body?.value;
console.log(`   ${r.status}  ${pv?.code}`);
r = await ravi(`/values/${pv.id}/assign`, { method:'POST', body: JSON.stringify({ meaning:'authorship' })});
console.log(`   assign ${r.status}  ${r.body?.value?.assignedValue} ± ${r.body?.value?.expandedUncertainty?.toPrecision(4)} % w/w`);

step(7, 'Ravi tries to authorise his own assignment');
r = await ravi(`/values/${pv.id}/authorise`, { method:'POST', body: JSON.stringify({ meaning:'approval' })});
console.log(`   ${r.status}  ${r.body?.detail}`);

step(8, 'Asha authorises, releases a lot, issues the certificate');
r = await asha(`/values/${pv.id}/authorise`, { method:'POST', body: JSON.stringify({ meaning:'approval' })});
console.log(`   authorise  ${r.status}  ${r.body?.value?.state}`);
r = await asha(`/projects/${prj.id}/release-lot`, { method:'POST', body: JSON.stringify({
  meaning:'responsibility', expiryDate:'2029-06-30', stockUnits:80, unitPriceMinor:600000 })});
const lot = r.body?.lot;
console.log(`   lot        ${r.status}  ${lot?.lotCode}  ${lot?.storageCondition}  cold=${lot?.coldChain}`);
r = await asha(`/lots/${lot.id}/certificate`, { method:'POST', body: JSON.stringify({ meaning:'approval' })});
console.log(`   cert       ${r.status}  ${r.body?.certificate?.code} #${r.body?.issue?.number}  ${r.body?.issue?.assignedValue} ± ${r.body?.issue?.expandedUncertainty?.toPrecision(4)}`);

step(9, 'verify the chain');
const neha = await actor('neha@producer.example');
r = await neha('/audit/verify', { method:'POST', body:'{}' });
console.log(`   ${r.status}  ${JSON.stringify(r.body)}`);
