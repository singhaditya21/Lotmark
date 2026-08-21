import { createHmac } from 'node:crypto';
const BASE='http://127.0.0.1:4000/api/v1', S='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', P='demo-password-1234';
function b32(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b='';for(const c of s.toUpperCase()){const i=A.indexOf(c);if(i<0)continue;b+=i.toString(2).padStart(5,'0')}const o=Buffer.alloc(Math.floor(b.length/8));for(let i=0;i<o.length;i++)o[i]=parseInt(b.slice(i*8,i*8+8),2);return o}
function totp(){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const m=createHmac('sha1',b32(S)).update(b).digest();const o=m[m.length-1]&15;return String(((m[o]&127)<<24|(m[o+1]&255)<<16|(m[o+2]&255)<<8|(m[o+3]&255))%1e6).padStart(6,'0')}
function session(){let c='';return async(p,o={})=>{const r=await fetch(BASE+p,{...o,headers:{'content-type':'application/json',...(c?{cookie:c}:{}),...o.headers}});const k=r.headers.get('set-cookie');if(k)c=k.split(';')[0];let b;try{b=await r.json()}catch{b=null}return{status:r.status,body:b}}}
async function login(email){const call=session();const f=await call('/auth/sign-in',{method:'POST',body:JSON.stringify({email,password:P})});if(f.body?.secondFactorRequired)await call('/auth/second-factor',{method:'POST',body:JSON.stringify({code:totp(),attempt:1})});return call}
const show=(l,r,extra='')=>console.log(`${l.padEnd(44)} ${String(r.status).padEnd(4)} ${r.status>=400?(r.body?.detail??'').slice(0,70):extra}`);

console.log('=== Meera (Laboratory QM, customer) ===');
const meera = await login('meera@genpharm.example');
const cat = await meera('/catalogue');
show('GET /catalogue', cat, `${cat.body?.items?.length ?? 0} item(s), canOrder=${cat.body?.canOrder}`);
const myOrders = await meera('/orders');
show('GET /orders (own)', myOrders, `scope=${myOrders.body?.scope} ${myOrders.body?.orders?.length ?? 0} order(s)`);
const vault = await meera('/vault');
show('GET /vault', vault, `${vault.body?.holdings?.length ?? 0} holding(s)`);
const lot = cat.body?.items?.find(i => i.stock_units > 0);
if (lot) {
  const placed = await meera('/orders', {method:'POST', body: JSON.stringify({lines:[{lotId:lot.id, quantity:1}]})});
  show('POST /orders', placed, placed.body?.code ?? '');
}
show('POST /entitlements', await meera('/entitlements', {method:'POST', body: JSON.stringify({supportingDocument:'Government laboratory registration GL-2291'})}));

console.log('\n=== Arjun (Commercial) ===');
const arjun = await login('arjun@producer.example');
const all = await arjun('/orders');
show('GET /orders (all)', all, `scope=${all.body?.scope} ${all.body?.orders?.length ?? 0} order(s)`);
const ents = await arjun('/entitlements');
show('GET /entitlements', ents, `${ents.body?.claims?.length ?? 0} claim(s), canDecide=${ents.body?.canDecide}`);
const claim = ents.body?.claims?.find(c => c.state === 'under_review');
if (claim) show('POST decide (approve)', await arjun(`/entitlements/${claim.id}/decide`, {method:'POST', body: JSON.stringify({approve:true, note:'Registration verified', revalidationDue:'2027-08-21'})}));
show('GET /vault (should be refused)', await arjun('/vault'));

console.log('\n=== Vikram (Dispatch) ===');
const vikram = await login('vikram@producer.example');
const disp = await vikram('/orders');
show('GET /orders', disp, `${disp.body?.orders?.length ?? 0} order(s), canAdvance=${disp.body?.canAdvance}`);
const placedOrder = disp.body?.orders?.find(o => o.state === 'placed');
if (placedOrder) {
  show('POST advance placed→packed', await vikram(`/orders/${placedOrder.id}/advance`, {method:'POST', body: JSON.stringify({to:'packed'})}));
  show('POST advance packed→delivered (illegal)', await vikram(`/orders/${placedOrder.id}/advance`, {method:'POST', body: JSON.stringify({to:'delivered'})}));
  const ship = await vikram(`/orders/${placedOrder.id}/shipment`, {method:'POST', body: JSON.stringify({temperatureClass:'2-8'})});
  show('POST /orders/:id/shipment', ship, ship.body?.code ?? '');
  if (ship.body?.id) {
    const r = await vikram(`/shipments/${ship.body.id}/readings`, {method:'POST', body: JSON.stringify({readings:[
      {readAt:'2026-08-20T08:00:00Z', celsius:5.1},
      {readAt:'2026-08-20T14:00:00Z', celsius:14.6},
    ]})});
    show('POST readings (one excursion)', r, `excursions=${r.body?.excursions} capa=${r.body?.capaRaised}`);
  }
}
