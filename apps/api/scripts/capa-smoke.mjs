/** The CAPA workflow: a nonconformity you can actually close. */
import { createHmac } from 'node:crypto';
const BASE='http://127.0.0.1:4000/api/v1', S='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', P='demo-password-1234';
function b32(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b='';for(const c of s.toUpperCase()){const i=A.indexOf(c);if(i<0)continue;b+=i.toString(2).padStart(5,'0')}const o=Buffer.alloc(Math.floor(b.length/8));for(let i=0;i<o.length;i++)o[i]=parseInt(b.slice(i*8,i*8+8),2);return o}
function totp(s){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const m=createHmac('sha1',b32(s)).update(b).digest();const o=m[m.length-1]&15;return String(((m[o]&127)<<24|(m[o+1]&255)<<16|(m[o+2]&255)<<8|(m[o+3]&255))%1e6).padStart(6,'0')}
function session(){let c='';return async(p,o={})=>{const r=await fetch(BASE+p,{...o,headers:{'content-type':'application/json',...(c?{cookie:c}:{}),...o.headers}});const k=r.headers.get('set-cookie');if(k)c=k.split(';')[0];let b;try{b=await r.json()}catch{b=null}return{status:r.status,body:b}}}
const call=session();
await call('/auth/sign-in',{method:'POST',body:JSON.stringify({email:'neha@producer.example',password:P})});
await call('/auth/second-factor',{method:'POST',body:JSON.stringify({code:totp(S),attempt:1})});

const list=(await call('/capa')).body.capa ?? [];
const target=list.find(c=>c.source==='Stability monitoring overdue');
if(!target){console.log('no CAPA to work with');process.exit(0)}
console.log(`\n${target.code}  ${target.source}  state=${target.state}`);
console.log(`  available: ${target.availableTransitions.join(', ')}`);

console.log('\n1. try to skip straight to closed');
let r=await call(`/capa/${target.id}/transition`,{method:'POST',body:JSON.stringify({to:'closed',reason:'just close it'})});
console.log(`   ${r.status}  ${r.body?.detail}`);

console.log('\n2. walk the declared machine');
for(const [to,reason] of [
  ['investigation','Reviewed against the monitoring schedule'],
  ['root_cause','Determined'],
  ['capa','Action agreed'],
  ['effectiveness','Check scheduled'],
]) {
  r=await call(`/capa/${target.id}/transition`,{method:'POST',body:JSON.stringify({to,reason})});
  console.log(`   → ${to.padEnd(14)} ${r.status}`);
}

console.log('\n3. close without a root cause');
r=await call(`/capa/${target.id}/transition`,{method:'POST',body:JSON.stringify({to:'closed',reason:'done'})});
console.log(`   ${r.status}  ${r.body?.detail?.slice(0,110)}`);

console.log('\n4. close with the reason stated, as the migration note requires');
r=await call(`/capa/${target.id}/transition`,{method:'POST',body:JSON.stringify({
  to:'closed',
  reason:'Raised in error by a defect in the monitoring-due job; fixed in migration 0011',
  rootCause:'notice_log used a plain UNIQUE, and SQL NULLs are distinct, so the ON CONFLICT never fired for notices with no organisation',
  correctiveAction:'Constraint changed to UNIQUE NULLS NOT DISTINCT; idempotency verified over three consecutive runs',
  preventiveAction:'Every notice-sending job now asserts idempotency in its test',
})});
console.log(`   ${r.status}  state=${r.body?.capa?.state}  from=${r.body?.from}`);
