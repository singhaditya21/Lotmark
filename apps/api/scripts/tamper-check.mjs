import { createHmac } from 'node:crypto';
const BASE='http://127.0.0.1:4000/api/v1'; const S='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; let cookie='';
function b32(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b='';for(const c of s.toUpperCase()){const i=A.indexOf(c);if(i<0)continue;b+=i.toString(2).padStart(5,'0')}const o=Buffer.alloc(Math.floor(b.length/8));for(let i=0;i<o.length;i++)o[i]=parseInt(b.slice(i*8,i*8+8),2);return o}
function totp(s){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const m=createHmac('sha1',b32(s)).update(b).digest();const o=m[m.length-1]&15;return String(((m[o]&127)<<24|(m[o+1]&255)<<16|(m[o+2]&255)<<8|(m[o+3]&255))%1e6).padStart(6,'0')}
const call=async(p,o={})=>{const r=await fetch(BASE+p,{...o,headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...o.headers}});const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];let b;try{b=await r.json()}catch{b=null}return{status:r.status,body:b}};
await call('/auth/sign-in',{method:'POST',body:JSON.stringify({email:'ravi@producer.example',password:'demo-password-1234'})});
await call('/auth/second-factor',{method:'POST',body:JSON.stringify({code:totp(S),attempt:1})});
const ps=(await call('/projects')).body.projects;
for(const p of ps){
  const s=await call(`/projects/${p.id}/studies`);
  const st=(s.body?.studies??[]).find(x=>x.code==='ST-1022');
  if(!st) continue;
  const v=await call(`/studies/${st.id}/signature`);
  console.log('verification after tampering:', v.status, JSON.stringify(v.body));
}
