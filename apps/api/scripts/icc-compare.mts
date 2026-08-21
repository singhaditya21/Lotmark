/** Cross-check our generated primaries against the system reference profile. */
import { readFileSync } from 'node:fs';
import { srgbProfile } from '../src/services/icc';

function tags(p: Buffer): Map<string, { off: number; size: number }> {
  const out = new Map<string, { off: number; size: number }>();
  const n = p.readUInt32BE(128);
  for (let i = 0; i < n; i++) {
    const b = 132 + i * 12;
    out.set(p.subarray(b, b + 4).toString('ascii'), { off: p.readUInt32BE(b + 4), size: p.readUInt32BE(b + 8) });
  }
  return out;
}
function xyz(p: Buffer, at: { off: number }): [number, number, number] {
  return [p.readInt32BE(at.off + 8), p.readInt32BE(at.off + 12), p.readInt32BE(at.off + 16)];
}
const APPLE = '/System/Library/ColorSync/Profiles/sRGB Profile.icc';
const ours = srgbProfile(), ref = readFileSync(APPLE);
const ot = tags(ours), rt = tags(ref);
console.log('tag    ours (s15Fixed16)                reference                        match');
for (const t of ['wtpt', 'rXYZ', 'gXYZ', 'bXYZ']) {
  const a = xyz(ours, ot.get(t)!), b = xyz(ref, rt.get(t)!);
  const same = a.every((v, i) => v === b[i]);
  const dec = (v: number[]) => v.map((x) => (x / 65536).toFixed(6)).join(', ');
  console.log(`${t}   ${dec(a).padEnd(32)} ${dec(b).padEnd(32)} ${same ? 'exact' : 'DIFFERS'}`);
}
// Compare the transfer curve at a few points against the reference table.
const oc = ot.get('rTRC')!, rc = rt.get('rTRC')!;
const on = ours.readUInt32BE(oc.off + 8), rn = ref.readUInt32BE(rc.off + 8);
console.log(`\nTRC entries: ours=${on} reference=${rn}`);
if (rn > 1) {
  let worst = 0;
  for (let i = 0; i < rn; i++) {
    const refv = ref.readUInt16BE(rc.off + 12 + i * 2) / 65535;
    const x = i / (rn - 1);
    const oursIdx = Math.round(x * (on - 1));
    const oursv = ours.readUInt16BE(oc.off + 12 + oursIdx * 2) / 65535;
    worst = Math.max(worst, Math.abs(refv - oursv));
  }
  console.log(`worst TRC deviation vs reference: ${(worst * 100).toFixed(4)} %`);
}
