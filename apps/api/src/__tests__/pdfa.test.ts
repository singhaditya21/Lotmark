import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { renderCertificate, type CertificateSnapshot } from '../services/certificate-pdf';
import { checkPdfA2b } from '../services/pdfa';
import { srgbProfile, srgbProfileDigest } from '../services/icc';

const SNAPSHOT: CertificateSnapshot = {
  producerName: 'Indian Pharmacopoeia Commission', producerAccreditation: 'NABL RMP-0042',
  certificateCode: 'CRT-2051', issueNumber: 1, issuedAt: '2026-08-21T09:15:00Z',
  lotCode: 'IPRSPARA0004', previousLotCode: null,
  materialName: 'Paracetamol', casNumber: '103-90-2',
  propertyName: 'Assay (as is)', assignedValue: 99.6734, expandedUncertainty: 0.5335,
  coverageFactor: 2, unit: '% w/w', expiryDate: '2028-03-31',
  storageCondition: '2-8 C', transportCondition: null,
  components: [{ symbol: 'u(bb)', value: 0.1014595978, basis: '6 units x 2 replicates' }],
  issuedByName: 'Dr. Asha Pillai', signedAt: '2026-08-21T09:15:00Z',
  signatureMeaning: 'approval', keyVersion: 'rec-v1', keyCustody: 'dev_file',
  verificationToken: 'k3nQ8vRtY2wPzL9mA4xB6dF1', reissueReason: null,
  verificationOrigin: 'https://certificates.example.org',
  conformanceFrame: 'ISO 17034 + GIGW 3.0 + DPDP',
};

/** Load, mutate, re-save — without pdf-lib rewriting the metadata as it goes. */
async function tamper(
  bytes: Uint8Array,
  mutate: (pdf: PDFDocument) => void,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  mutate(pdf);
  return pdf.save({ useObjectStreams: false });
}

describe('the certificate meets the PDF/A-2b requirements this checker covers', () => {
  it('passes every checked requirement', async () => {
    const report = await checkPdfA2b(await renderCertificate(SNAPSHOT));
    expect(
      report.findings,
      report.findings.map((f) => `${f.clause}: ${f.detail}`).join('; '),
    ).toEqual([]);
    expect(report.conformsToCheckedSubset).toBe(true);
    expect(report.checked.length).toBeGreaterThan(0);
  });

  it('never presents itself as a full conformance verdict', async () => {
    // The honesty property. A passing report that did not say what it skipped
    // would be read as "this is PDF/A", which this tool cannot establish —
    // there is no Java on this machine and therefore no veraPDF.
    const report = await checkPdfA2b(await renderCertificate(SNAPSHOT));
    expect(report.notChecked.length).toBeGreaterThan(0);
    expect(Object.keys(report)).not.toContain('conformsToPdfA');
  });
});

describe('the checker actually catches what it claims to', () => {
  it('catches a missing OutputIntent', async () => {
    const broken = await tamper(await renderCertificate(SNAPSHOT), (pdf) => {
      pdf.catalog.delete(PDFName.of('OutputIntents'));
    });
    const report = await checkPdfA2b(broken);
    expect(report.conformsToCheckedSubset).toBe(false);
    expect(report.findings.some((f) => f.clause === '6.2.2')).toBe(true);
  });

  it('catches an OutputIntent whose profile is not an ICC profile', async () => {
    // A stream that is PRESENT but is not a profile is the more dangerous
    // failure: the structure looks right to anything that only checks that the
    // key exists.
    const broken = await tamper(await renderCertificate(SNAPSHOT), (pdf) => {
      const intents = pdf.catalog.lookup(PDFName.of('OutputIntents')) as never as
        { get: (i: number) => unknown };
      const dict = pdf.context.lookup(intents.get(0) as never) as PDFDict;
      dict.set(
        PDFName.of('DestOutputProfile'),
        pdf.context.register(pdf.context.stream(Buffer.alloc(200), { N: 3 })),
      );
    });
    const report = await checkPdfA2b(broken);
    expect(report.findings.some((f) => f.detail.includes('acsp'))).toBe(true);
  });

  it('catches a font name without a subset prefix', async () => {
    const broken = await tamper(await renderCertificate(SNAPSHOT), (pdf) => {
      for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (obj.get(PDFName.of('Type'))?.toString() !== '/Font') continue;
        const base = obj.get(PDFName.of('BaseFont'))?.toString();
        if (base) obj.set(PDFName.of('BaseFont'), PDFName.of(base.replace(/^\/[A-Z]{6}\+/, '')));
      }
    });
    const report = await checkPdfA2b(broken);
    expect(report.findings.some((f) => f.requirement.includes('six uppercase letters'))).toBe(true);
  });

  it('catches a title that disagrees between XMP and the information dictionary', async () => {
    // A regression guard for a defect this checker found in the renderer: the
    // two carried different titles, and 6.7.3 requires them to agree.
    const broken = await tamper(await renderCertificate(SNAPSHOT), (pdf) => {
      pdf.setTitle('Something else entirely');
    });
    const report = await checkPdfA2b(broken);
    expect(report.findings.some((f) => f.clause === '6.7.3')).toBe(true);
  });
});

describe('the XMP packet survives characters above Latin-1', () => {
  it('carries an em-dash and a greater-or-equal sign intact', async () => {
    /**
     * The other defect the conformance check found. pdf-lib writes a string
     * stream by truncating each character to one byte, so the em-dash in the
     * title arrived as 0x14 — and any material name carrying a non-Latin-1
     * character would have been corrupted the same way, in the one part of the
     * document a machine is meant to read.
     */
    const name = 'Paracetamol — ≥99 % purity';
    const bytes = await renderCertificate({ ...SNAPSHOT, materialName: name });
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const metadata = pdf.catalog.lookup(PDFName.of('Metadata')) as never as
      { getContents: () => Uint8Array };
    const xmp = Buffer.from(metadata.getContents()).toString('utf8');
    expect(xmp).toContain(name);
    // The specific corruption: U+2014 truncated to the single byte 0x14.
    expect(xmp).not.toContain(String.fromCharCode(0x14));
  });
});

describe('the embedded sRGB profile', () => {
  it('is a structurally valid ICC profile', () => {
    const p = srgbProfile();
    expect(p.readUInt32BE(0), 'declared size must match actual').toBe(p.length);
    expect(p.subarray(36, 40).toString('ascii')).toBe('acsp');
    expect(p.subarray(16, 20).toString('ascii')).toBe('RGB ');
    expect(p.subarray(20, 24).toString('ascii')).toBe('XYZ ');
    // Every tag must lie inside the file and start on a four-byte boundary.
    const n = p.readUInt32BE(128);
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const b = 132 + i * 12;
      const off = p.readUInt32BE(b + 4);
      const size = p.readUInt32BE(b + 8);
      expect(off % 4, 'tag offsets must be aligned').toBe(0);
      expect(off + size).toBeLessThanOrEqual(p.length);
    }
  });

  it('is byte-stable — it carries no clock and no randomness', () => {
    // The profile is embedded in every certificate. If it varied, every
    // certificate would vary with it, and nothing else in the renderer would
    // matter.
    expect(srgbProfileDigest()).toBe(srgbProfileDigest());
    expect(srgbProfileDigest())
      .toBe('fb7f4591531e2e6e70b42378c9806a2ddd70c0de522a2b30c35b94f11824769c');
  });
});
