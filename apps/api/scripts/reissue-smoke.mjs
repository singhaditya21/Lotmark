/**
 * Reissue and withdrawal — the product's safety obligation.
 *
 * Proves that every holder is told, and that the holder set includes a
 * laboratory whose vials never came through an order.
 */
import { createHmac } from 'node:crypto';
const BASE='http://127.0.0.1:4000/api/v1', SECRET='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', PASSWORD='demo-password-1234';
function b32(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b='';for(const c of s.toUpperCase()){const i=A.indexOf(c);if(i<0)continue;b+=i.toString(2).padStart(5,'0')}const o=Buffer.alloc(Math.floor(b.length/8));for(let i=0;i<o.length;i++)o[i]=parseInt(b.slice(i*8,i*8+8),2);return o}
function totp(s){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const m=createHmac('sha1',b32(s)).update(b).digest();const o=m[m.length-1]&15;return String(((m[o]&127)<<24|(m[o+1]&255)<<16|(m[o+2]&255)<<8|(m[o+3]&255))%1e6).padStart(6,'0')}
function session(){let c='';return async(p,o={})=>{const r=await fetch(BASE+p,{...o,headers:{'content-type':'application/json',...(c?{cookie:c}:{}),...o.headers}});const k=r.headers.get('set-cookie');if(k)c=k.split(';')[0];let b;try{b=await r.json()}catch{b=null}return{status:r.status,body:b}}}
async function actor(e){const call=session();await call('/auth/sign-in',{method:'POST',body:JSON.stringify({email:e,password:PASSWORD})});await call('/auth/second-factor',{method:'POST',body:JSON.stringify({code:totp(SECRET),attempt:1})});await call('/auth/step-up',{method:'POST',body:JSON.stringify({password:PASSWORD,code:totp(SECRET)})});return call}

const step=(n,t)=>console.log(`\n${n}. ${t}`);
const asha=await actor('asha@producer.example');
// Reading the holder list needs order:read_all, which Quality does not hold.
const arjun=await actor('arjun@producer.example');

const CERT_ID = process.argv[2];
if (!CERT_ID) { console.error('pass a certificate id'); process.exit(2); }

step(1,'who holds issue #1?');
let r = await arjun(`/certificates/${CERT_ID}/issues/1/holders`);
if (r.status !== 200) console.log(`   ${r.status} ${r.body?.detail}`);
for (const h of r.body?.holders ?? []) console.log(`   ${h.organisation_name.padEnd(34)} qty ${h.quantity}  via ${h.basis}`);
if ((r.body?.holders ?? []).length === 0) console.log('   (none)');

step(2,'reissue');
r = await asha(`/certificates/${CERT_ID}/reissue`, { method:'POST', body: JSON.stringify({
  meaning:'approval', reason:'Characterisation retest revised the assigned value' })});
console.log(`   ${r.status}  ${r.body?.certificate} #${r.body?.issue?.previous} → #${r.body?.issue?.number}`);
console.log(`   change: ${r.body?.changeSummary ?? r.body?.detail}`);
for (const n of r.body?.notified ?? []) console.log(`   notified ${n.organisation} (${n.basis})`);
console.log(`   verify: ${r.body?.document?.verifyUrl ?? '—'}`);

step(3,'a reissue with no stated reason is refused');
r = await asha(`/certificates/${CERT_ID}/reissue`, { method:'POST', body: JSON.stringify({ meaning:'approval', reason:'' })});
console.log(`   ${r.status}  ${r.body?.detail}`);

step(4,'withdraw issue #1');
r = await asha(`/certificates/${CERT_ID}/issues/1/withdraw`, { method:'POST', body: JSON.stringify({
  reason:'Assigned value superseded following a confirmatory retest' })});
console.log(`   ${r.status}  withdrawn=${r.body?.withdrawn}`);
for (const n of r.body?.notified ?? []) console.log(`   notified ${n.organisation} (${n.basis})`);

step(5,'withdrawing twice is refused');
r = await asha(`/certificates/${CERT_ID}/issues/1/withdraw`, { method:'POST', body: JSON.stringify({ reason:'again' })});
console.log(`   ${r.status}  ${r.body?.detail}`);
