/**
 * The certificate conformance gate.
 *
 * Runs two checks against a freshly rendered certificate:
 *
 *   1. The structural PDF/A-2b check in src/services/pdfa.ts, which this
 *      repository can run anywhere. It is a HARD gate: a failure exits non-zero.
 *
 *   2. veraPDF, the reference implementation of ISO 19005, which is the only
 *      thing that can actually establish conformance. It is a Java application
 *      and there is no Java runtime on this machine, so it usually cannot run
 *      here.
 *
 * ── The rule this script exists to enforce ──────────────────────────────────
 *
 * When veraPDF is absent the script does NOT quietly succeed. It prints an
 * unmissable notice saying the conformance claim is unverified, because a green
 * tick that means "we did not check" is worse than no tick at all — it is the
 * exact shape of the overclaim this product refuses to make about key custody,
 * about signatures, and about holder notifications.
 *
 * Pass --require-verapdf in an environment that is supposed to have it (a real
 * CI runner) and the absence becomes a failure rather than a notice.
 *
 *   pnpm --filter @lotmark/api pdfa
 *   pnpm --filter @lotmark/api pdfa --require-verapdf
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCertificate, RENDERER_VERSION, type CertificateSnapshot } from '../src/services/certificate-pdf';
import { checkPdfA2b, formatReport } from '../src/services/pdfa';

const SNAPSHOT: CertificateSnapshot = {
  producerName: 'Indian Pharmacopoeia Commission',
  producerAccreditation: 'NABL RMP-0042',
  certificateCode: 'CRT-2051', issueNumber: 1, issuedAt: '2026-08-21T09:15:00Z',
  lotCode: 'IPRSPARA0004', previousLotCode: null,
  materialName: 'Paracetamol', casNumber: '103-90-2',
  propertyName: 'Assay (as is)', assignedValue: 99.6734,
  expandedUncertainty: 0.5335, coverageFactor: 2, unit: '% w/w',
  expiryDate: '2028-03-31', storageCondition: '2-8 C', transportCondition: null,
  components: [
    { symbol: 'u(bb)', value: 0.1014595978, basis: '6 units x 2 replicates, one-way ANOVA' },
    { symbol: 'u(lts)', value: 0.1744840726, basis: '6 timepoints over 28 months' },
  ],
  issuedByName: 'Dr. Asha Pillai', signedAt: '2026-08-21T09:15:00Z',
  signatureMeaning: 'approval', keyVersion: 'rec-v1', keyCustody: 'dev_file',
  verificationToken: 'k3nQ8vRtY2wPzL9mA4xB6dF1', reissueReason: null,
  conformanceFrame: 'ISO 17034 + GIGW 3.0 + DPDP',
};

const requireVeraPdf = process.argv.includes('--require-verapdf');
const rule = '─'.repeat(78);

console.log(rule);
console.log(`Certificate conformance gate · renderer ${RENDERER_VERSION}`);
console.log(rule);

const bytes = await renderCertificate(SNAPSHOT);
console.log(`rendered ${bytes.length} bytes\n`);

/* ── 1. The check we can always run ───────────────────────────────────────── */

const report = await checkPdfA2b(bytes);
console.log(formatReport(report));
console.log();

if (!report.conformsToCheckedSubset) {
  console.error('GATE FAILED: the structural PDF/A check found problems (above).');
  process.exit(1);
}

/* ── 2. The check that would actually settle it ───────────────────────────── */

function findVeraPdf(): string | null {
  for (const candidate of ['verapdf', `${process.env['HOME']}/verapdf/verapdf`, '/usr/local/bin/verapdf']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // Not at this path, or not runnable. Try the next.
    }
  }
  return null;
}

const verapdf = findVeraPdf();

if (!verapdf) {
  const notice = [
    '',
    '='.repeat(78),
    'PDF/A CONFORMANCE IS UNVERIFIED',
    '='.repeat(78),
    '',
    'veraPDF is not available on this machine, so the checks above are the only',
    'ones that ran. They cover the structural requirements listed under "Checked"',
    'and NOT the ones listed under "NOT checked".',
    '',
    'This document is BUILT to PDF/A-2b and passes every check available here.',
    'That is not the same as being verified as PDF/A-2b, and nothing in this',
    'repository should say that it is.',
    '',
    'To settle it, install a Java runtime and veraPDF, then re-run this gate:',
    '    brew install --cask temurin',
    '    brew install verapdf',
    '    pnpm --filter @lotmark/api pdfa --require-verapdf',
    '='.repeat(78),
    '',
  ].join('\n');

  if (requireVeraPdf) {
    console.error(notice);
    console.error('GATE FAILED: --require-verapdf was passed and veraPDF is not installed.');
    process.exit(1);
  }
  console.warn(notice);
  // Exit 0 deliberately: the checks that ran did pass, and this is a
  // development machine. The notice above is what stops that being mistaken
  // for a conformance result.
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), 'lotmark-pdfa-'));
const file = path.join(dir, 'certificate.pdf');
writeFileSync(file, bytes);

console.log(`veraPDF found at ${verapdf} — running the reference validator.\n`);
try {
  const out = execFileSync(verapdf, ['-f', '2b', '--format', 'text', file], { encoding: 'utf8' });
  console.log(out);
  if (/\bnonCompliant\b|FAIL/i.test(out)) {
    console.error('GATE FAILED: veraPDF reports the document is not PDF/A-2b.');
    process.exit(1);
  }
  console.log('GATE PASSED: veraPDF confirms PDF/A-2b conformance.');
} catch (e) {
  const err = e as { stdout?: string; stderr?: string; message?: string };
  console.error(err.stdout ?? '');
  console.error(err.stderr ?? err.message ?? String(e));
  console.error('GATE FAILED: veraPDF exited non-zero.');
  process.exit(1);
}
