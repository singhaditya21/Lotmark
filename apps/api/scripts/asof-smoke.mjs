/** Point-in-time reads: the register as it stood on a date. */
import { createHmac } from 'node:crypto';
const BASE='http://127.0.0.1:4000/api/v1', S='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', P='demo-password-1234';
function b32(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b='';for(const c of s.toUpperCase()){const i=A.indexOf(c);if(i<0)continue;b+=i.toString(2).padStart(5,'0')}const o=Buffer.alloc(Math.floor(b.length/8));for(let i=0;i<o.length;i++)o[i]=parseInt(b.slice(i*8,i*8+8),2);return o}
function totp(s){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const m=createHmac('sha1',b32(s)).update(b).digest();const o=m[m.length-1]&15;return String(((m[o]&127)<<24|(m[o+1]&255)<<16|(m[o+2]&255)<<8|(m[o+3]&255))%1e6).padStart(6,'0')}
function session(){let c='';return async(p,o={})=>{const r=await fetch(BASE+p,{...o,headers:{'content-type':'application/json',...(c?{cookie:c}:{}),...o.headers}});const k=r.headers.get('set-cookie');if(k)c=k.split(';')[0];let b;try{b=await r.json()}catch{b=null}return{status:r.status,body:b}}}
const call=session();
await call('/auth/sign-in',{method:'POST',body:JSON.stringify({email:'neha@producer.example',password:P})});
await call('/auth/second-factor',{method:'POST',body:JSON.stringify({code:totp(S),attempt:1})});
const prj=(await call('/projects')).body.projects.find(p=>p.code==='PRJ-0412');

for (const date of ['2025-10-01','2026-01-01','2026-08-21']) {
  const r = await call(`/projects/${prj.id}/as-of?date=${date}`);
  console.log(`\nas at ${date}  →  ${r.status}`);
  for (const s of r.body?.studies ?? [])
    console.log(`   ${s.code}  ${s.study_type.padEnd(17)} ${s.state.padEnd(7)} signed ${s.signed_on ?? '—'}`);
  for (const l of r.body?.lots ?? [])
    console.log(`   lot ${l.lot_code}  was ${l.state_then}`);
  if ((r.body?.studies ?? []).length === 0) console.log('   (nothing existed yet)');
}
const future = await call(`/projects/${prj.id}/as-of?date=2099-01-01`);
console.log(`\nas at 2099-01-01  →  ${future.status}  ${future.body?.detail}`);
