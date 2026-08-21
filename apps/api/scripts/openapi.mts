/**
 * Write the OpenAPI document.
 *
 *   pnpm --filter @lotmark/api openapi
 *
 * The document is a by-product: `openapi.test.ts` is what keeps it honest, by
 * comparing the registry it is built from against the routes Fastify actually
 * registered, in both directions. Regenerating without running the tests
 * produces a file that looks authoritative and may not be.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildOpenApi } from '../src/http/openapi';

const doc = buildOpenApi();
const out = path.resolve('../../docs/api/openapi.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);

const operations = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
console.log(`wrote ${path.relative(process.cwd(), out)} — ${operations} operations across ${Object.keys(doc.paths).length} paths`);
console.log('The drift test in src/__tests__/openapi.test.ts is what makes this trustworthy.');
