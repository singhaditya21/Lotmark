/**
 * What can each persona actually DO?
 *
 * Signs in as every seeded account and probes the surfaces a person in that
 * role would need. Reports what the CONSOLE offers them and what the API
 * allows, so "is the journey built" is answered by evidence rather than by
 * reading the role table.
 */
import { createHmac } from 'node:crypto';
const BASE='http://127.0.0.1:4000/api/v1', S='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', P='demo-password-1234';
function b32(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b='';for(const c of s.toUpperCase()){const i=A.indexOf(c);if(i<0)continue;b+=i.toString(2).padStart(5,'0')}const o=Buffer.alloc(Math.floor(b.length/8));for(let i=0;i<o.length;i++)o[i]=parseInt(b.slice(i*8,i*8+8),2);return o}
function totp(s){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const m=createHmac('sha1',b32(s)).update(b).digest();const o=m[m.length-1]&15;return String(((m[o]&127)<<24|(m[o+1]&255)<<16|(m[o+2]&255)<<8|(m[o+3]&255))%1e6).padStart(6,'0')}
function session(){let c='';return async(p,o={})=>{const r=await fetch(BASE+p,{...o,headers:{'content-type':'application/json',...(c?{cookie:c}:{}),...o.headers}});const k=r.headers.get('set-cookie');if(k)c=k.split(';')[0];let b;try{b=await r.json()}catch{b=null}return{status:r.status,body:b}}}

const PEOPLE = [
  ['ravi@producer.example',    'RM Scientist',      'producer'],
  ['sunil@producer.example',   'Production Lead',   'producer'],
  ['asha@producer.example',    'Technical Manager', 'producer'],
  ['neha@producer.example',    'Quality Manager',   'producer'],
  ['arjun@producer.example',   'Commercial',        'producer'],
  ['vikram@producer.example',  'Dispatch',          'producer'],
  ['admin@producer.example',   'Tenant Admin',      'producer'],
  ['meera@genpharm.example',   'Laboratory QM',     'customer'],
  ['suresh@sdtl.gov.example',  'Laboratory Buyer',  'customer'],
];

// The console decides its nav from these, exactly as App.tsx does.
const CONSOLE_NAV = [
  ['Projects',          () => true],
  ['Complaints & CAPA', (p) => p.has('capa:manage')],
  ['Audit ledger',      (p) => p.has('audit:read')],
];

// What a person in each role needs in order to do their job at all.
const NEEDS = {
  'RM Scientist':      ['/projects', '/equipment'],
  'Production Lead':   ['/projects', '/equipment', '/teams'],
  'Technical Manager': ['/projects'],
  'Quality Manager':   ['/capa', '/audit'],
  'Commercial':        ['/orders', '/catalogue', '/entitlements'],
  'Dispatch':          ['/orders', '/dispatch', '/shipments'],
  'Tenant Admin':      ['/users', '/roles', '/config'],
  'Laboratory QM':     ['/catalogue', '/my/orders', '/my/vault'],
  'Laboratory Buyer':  ['/catalogue', '/my/orders', '/my/vault'],
};

console.log('persona                console nav                              needs → reachable?');
console.log('─'.repeat(104));

for (const [email, role] of PEOPLE) {
  const call = session();
  const si = await call('/auth/sign-in',{method:'POST',body:JSON.stringify({email,password:P})});
  if (si.body?.secondFactorRequired) {
    await call('/auth/second-factor',{method:'POST',body:JSON.stringify({code:totp(S),attempt:1})});
  }
  const me = await call('/auth/me');
  if (me.status !== 200) { console.log(`${role.padEnd(22)} SIGN-IN FAILED ${me.status}`); continue; }

  const held = new Set([...(me.body.permissions ?? []),
                        ...Object.values(me.body.permissionsByTeam ?? {}).flat()]);
  const nav = CONSOLE_NAV.filter(([, f]) => f(held)).map(([n]) => n);

  const results = [];
  for (const path of NEEDS[role] ?? []) {
    const r = await call(path);
    results.push(`${path}${r.status === 404 ? ' ✗404' : r.status === 403 ? ' ⊘403' : ' ✓'}`);
  }
  console.log(`${role.padEnd(22)} ${nav.join(', ').padEnd(40)} ${results.join('  ')}`);
}
