/**
 * Extracts the prototype's seed dataset into JSON.
 *
 * Reads docs/artefacts/lotmark-app.html, slices out the `const DB = {...}`
 * literal and evaluates it in isolation. Deriving the fixture from the artefact
 * rather than retyping it means the demo data provably matches the prototype
 * the golden statistics tests are pinned against.
 *
 * Run: node src/seed/extract-prototype.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const artefact = path.resolve(here, '../../../../docs/artefacts/lotmark-app.html');
const src = fs.readFileSync(artefact, 'utf8');

const lines = src.split('\n');
const start = lines.findIndex((l) => l.startsWith('const DB={'));
if (start < 0) throw new Error('Could not locate `const DB={` in the artefact.');

// The literal ends at the line closing the object; find it by brace balance.
let depth = 0, end = -1;
for (let i = start; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (depth === 0) { end = i; break; }
}
if (end < 0) throw new Error('Unbalanced braces while slicing the DB literal.');

const literal = lines.slice(start, end + 1).join('\n');
const tmp = path.join(here, '.extract.tmp.mjs');
fs.writeFileSync(tmp, `${literal}\nexport default DB;\n`);

const DB = (await import(`file://${tmp}`)).default;
fs.unlinkSync(tmp);

// Also pull the static reference tables the prototype held outside DB.
const grab = (name) => {
  const s = src.indexOf(`const ${name}=`);
  if (s < 0) return null;
  let d = 0, i = src.indexOf('[', s), j = i;
  for (; j < src.length; j++) {
    if (src[j] === '[') d++;
    else if (src[j] === ']') { d--; if (d === 0) break; }
  }
  return src.slice(i, j + 1);
};

const usersLiteral = grab('USERS');
const orgsLiteral = grab('ORGS');
const tmp2 = path.join(here, '.extract2.tmp.mjs');
fs.writeFileSync(tmp2, `export const USERS=${usersLiteral};\nexport const ORGS=${orgsLiteral};\n`);
const { USERS, ORGS } = await import(`file://${tmp2}`);
fs.unlinkSync(tmp2);

const out = { DB, USERS, ORGS, extractedFrom: 'docs/artefacts/lotmark-app.html' };
const dest = path.join(here, 'prototype-data.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2));

console.log('projects   ', DB.projects.length);
console.log('studies    ', DB.studies.length);
console.log('results    ', Object.keys(DB.results).length);
console.log('values     ', DB.values.length);
console.log('lots       ', DB.lots.length);
console.log('certs      ', DB.certs.length);
console.log('orders     ', DB.orders.length);
console.log('equipment  ', DB.equipment.length);
console.log('competence ', DB.competence.length);
console.log('users      ', USERS.length);
console.log('orgs       ', ORGS.length);
console.log('→', path.relative(process.cwd(), dest));
