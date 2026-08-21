/**
 * Verify a certificate PDF independently.
 *
 * Takes a PDF file and a public key PEM. Touches no database, needs no account,
 * imports nothing from this project. This is what an auditor at a customer's
 * site can run against a file they were emailed and a key they read off the
 * public verification page.
 *
 *   node verify-certificate.mjs <cert.pdf> <public-key.pem> <signature-base64>
 */
import { readFileSync } from 'node:fs';
import { createPublicKey, verify, createHash } from 'node:crypto';

const [, , pdfPath, keyPath, signature] = process.argv;
if (!pdfPath || !keyPath || !signature) {
  console.error('usage: verify-certificate.mjs <cert.pdf> <public-key.pem> <signature-base64>');
  process.exit(2);
}

const pdf = readFileSync(pdfPath);
const publicKey = createPublicKey(readFileSync(keyPath, 'utf8'));

// The signature is over the document bytes, base64-encoded — the same payload
// the issuing service signed.
const payload = Buffer.from(pdf.toString('base64'), 'utf8');
const ok = verify(null, payload, publicKey, Buffer.from(signature, 'base64'));

console.log('file      ', pdfPath);
console.log('bytes     ', pdf.byteLength);
console.log('sha-256   ', createHash('sha256').update(pdf).digest('hex'));
console.log('signature ', ok ? 'VALID — this is the document that was signed'
                             : 'INVALID — the file does not match the signature');
process.exit(ok ? 0 : 1);
