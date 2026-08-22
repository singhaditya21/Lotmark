import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  renderCertificate, snapshotDigest, RENDERER_VERSION, TEMPLATE_KEY,
  type CertificateSnapshot,
} from '../services/certificate-pdf';

const SNAPSHOT: CertificateSnapshot = {
  producerName: 'Indian Pharmacopoeia Commission',
  producerAccreditation: 'NABL RMP-0042',
  certificateCode: 'CRT-2051', issueNumber: 1,
  issuedAt: '2026-08-21T09:15:00Z',
  lotCode: 'IPRSPARA0004', previousLotCode: 'IPRSPARA0003',
  materialName: 'Paracetamol', casNumber: '103-90-2',
  propertyName: 'Assay (as is)',
  assignedValue: 99.6734, expandedUncertainty: 0.5335, coverageFactor: 2, unit: '% w/w',
  expiryDate: '2028-03-31', storageCondition: '2–8 °C', transportCondition: 'Chilled 72 h',
  components: [
    { symbol: 'u(bb)', value: 0.1014595978, basis: '6 units × 2 replicates, one-way ANOVA' },
    { symbol: 'u(lts)', value: 0.1744840726, basis: '6 timepoints over 28 months' },
    { symbol: 'u(char)', value: 0.1744060205, basis: '5 laboratories, s = 0.390' },
  ],
  issuedByName: 'Dr. Asha Pillai',
  signedAt: '2026-08-21T09:15:00Z', signatureMeaning: 'approval',
  keyVersion: 'v1', keyCustody: 'dev_file',
  verificationToken: 'k3nQ8vRtY2wPzL9mA4xB6dF1',
  verificationOrigin: 'https://certificates.example.org',
  reissueReason: null,
  conformanceFrame: 'ISO 17034 + GIGW 3.0 + DPDP',
};

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * The bytes this snapshot renders to, pinned.
 *
 * Stable across three separate processes before it was written down, so it is a
 * property of the renderer rather than of one run.
 *
 * ── Why the tests below were not enough ─────────────────────────────────────
 *
 * They render the same in-memory object TWICE IN ONE PROCESS and compare. That
 * catches non-determinism — a wall clock, a random document ID — and it cannot
 * catch a change to the layout, the font, the margins, the wording, the number
 * formatting or the ICC profile. Every constant in `certificate-pdf.ts` could
 * move and the suite stayed green. `ARCHITECTURE.md:1031` describes this test;
 * it had never been written.
 *
 * ── What to do when it fails ────────────────────────────────────────────────
 *
 * Look at the change and decide whether the document was MEANT to move. A
 * certificate already issued is re-rendered from its stored snapshot to check
 * its hash, so a deliberate change to the renderer breaks that check for every
 * certificate issued before it — which is what `renderer_version` on the issue
 * exists to record. Bump it, and update this hash in the same commit.
 *
 * Do not update this hash on its own. That is the one edit that turns the test
 * back into the thing it replaced.
 */
/*
 * Moved once, deliberately, from
 * 781b4965019bd72dc9ffeb69b80ba00894fe1e1731a82d1c073d6d34a6064e40.
 *
 * The verification footer used to be a hard-coded `http://localhost:5173`. It
 * now prints the origin recorded in the snapshot, so the bytes changed and
 * RENDERER_VERSION went to lotmark-pdf-3 in the same commit, as the note above
 * requires. Certificates issued under pdf-2 are still covered by the stored
 * digest check; they are simply no longer re-renderable, which is what a
 * renderer version is for.
 */
const GOLDEN_SHA256 =
  '8decda6946f7bec9630f5198b179888f19b4c52a270238c5d78e2459969dc689';
const GOLDEN_BYTES = 44096;

describe('the address an auditor is told to visit', () => {
  /**
   * The footer used to read `http://localhost:5173/verify/<token>`, hard-coded,
   * on every certificate this system had ever produced.
   *
   * The failure was quiet in the way that matters: `config.ts` refuses a
   * loopback PUBLIC_ORIGIN in production and says why — a printed certificate
   * cannot be recalled — so the control existed, was tested, and guarded a
   * value that never reached the renderer. `CertificateSnapshot` had no origin
   * field, so `renderCertificate` could not have honoured it even if asked.
   *
   * Asserting on the rendered BYTES rather than on the snapshot, because the
   * snapshot carrying the right value is not the claim. The claim is that the
   * paper says it.
   */
  /**
   * What a person holding the certificate actually reads.
   *
   * Getting this right took three attempts, and the two failures are the point.
   *
   * A PDF's text lives in Flate-compressed content streams, so searching the
   * raw bytes finds nothing — and, worse, a `not.toContain('localhost:5173')`
   * against those bytes PASSES whatever the footer says, because the string is
   * never there in literal form. That assertion would have been exactly the
   * kind of test this codebase has spent a week deleting.
   *
   * Inflating is not enough either. The text is written as subset-font glyph
   * ids — `<00010002...> Tj` — so it has to be mapped back through the
   * `/ToUnicode` CMap that pdf-lib embeds beside each font.
   *
   * Each font has its own CMap and its own glyph numbering, so a single merged
   * map would decode one font's runs with another font's alphabet. Every CMap
   * is therefore tried separately and the candidates returned together: the
   * caller asserts a string appears in ONE of them, which cannot produce a
   * false pass and cannot be corrupted by a collision.
   */
  const renderedTexts = (pdf: Uint8Array): string[] => {
    const buf = Buffer.from(pdf);
    const streams: string[] = [];
    let at = 0;
    for (;;) {
      const start = buf.indexOf('stream', at);
      if (start < 0) break;
      const end = buf.indexOf('endstream', start);
      if (end < 0) break;
      let from = start + 'stream'.length;
      if (buf[from] === 0x0d) from++;
      if (buf[from] === 0x0a) from++;
      try { streams.push(inflateSync(buf.subarray(from, end)).toString('latin1')); }
      catch { /* a font file or the ICC profile, not a Flate stream */ }
      // `endstream` contains `stream`; advancing by one desynchronises the scan
      // onto its own terminator and silently skips every CMap in the file.
      at = end + 'endstream'.length;
    }

    const all = streams.join('\n');
    const maps: Array<Map<number, string>> = [];
    for (const block of all.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      const m = new Map<number, string>();
      for (const pair of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        // The destination is UTF-16BE and may be more than one code unit — a
        // ligature maps one glyph to several. Decoding it as a single integer
        // yields code points like 6684777 and throws.
        const dst = pair[2]!;
        let text = '';
        for (let i = 0; i + 3 < dst.length; i += 4) {
          text += String.fromCharCode(parseInt(dst.slice(i, i + 4), 16));
        }
        m.set(parseInt(pair[1]!, 16), text);
      }
      if (m.size > 0) maps.push(m);
    }

    const runs = [...all.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)].map((r) => r[1]!);
    return maps.map((map) => runs.map((hex) => {
      let word = '';
      for (let i = 0; i + 3 < hex.length; i += 4) {
        word += map.get(parseInt(hex.slice(i, i + 4), 16)) ?? '';
      }
      return word;
    }).join('\n'));
  };

  const readsSomewhere = (pdf: Uint8Array, needle: string): boolean =>
    renderedTexts(pdf).some((t) => t.includes(needle));

  it('is the one that was issued, not a development server', async () => {
    const pdf = await renderCertificate(SNAPSHOT);
    const decoded = renderedTexts(pdf);
    expect(decoded.length, 'nothing decoded — every assertion below would be vacuous')
      .toBeGreaterThan(0);
    expect(readsSomewhere(pdf, `${SNAPSHOT.verificationOrigin}/verify/${SNAPSHOT.verificationToken}`),
      'the verification footer does not carry the issued origin').toBe(true);
    expect(readsSomewhere(pdf, 'localhost:5173'),
      'the certificate still sends an auditor to a development server').toBe(false);
  });

  it('follows the origin the certificate was issued under', async () => {
    /*
     * Two origins, two documents. If the footer were still a constant these
     * would be byte-identical — which is exactly how the bug survived: every
     * other determinism test in this file renders the SAME object twice, and
     * a hard-coded string is perfectly deterministic.
     */
    const other = await renderCertificate({
      ...SNAPSHOT, verificationOrigin: 'https://certs.another-producer.example',
    });
    const mine = await renderCertificate(SNAPSHOT);
    expect(Buffer.compare(Buffer.from(other), Buffer.from(mine))).not.toBe(0);
    expect(readsSomewhere(other, 'https://certs.another-producer.example/verify/')).toBe(true);
    expect(readsSomewhere(mine, 'another-producer')).toBe(false);
  });
});

describe('the certificate renders deterministically', () => {
  it('renders the bytes it has always rendered', async () => {
    const pdf = await renderCertificate(SNAPSHOT);
    expect(sha(pdf), 'the certificate document changed — see GOLDEN_SHA256')
      .toBe(GOLDEN_SHA256);
    // Reported separately: a length change alone localises the diff quickly.
    expect(pdf.length).toBe(GOLDEN_BYTES);
  });

  it('produces byte-identical output for the same snapshot', async () => {
    // THE property. A certificate states a value somebody relies on for years;
    // "here is the document we issued" only means something if re-rendering the
    // same inputs reproduces it exactly.
    const a = await renderCertificate(SNAPSHOT);
    const b = await renderCertificate(SNAPSHOT);
    expect(sha(a)).toBe(sha(b));
  });

  it('does not vary with the wall clock', async () => {
    // PDF stamps CreationDate from `now` by default, and pdf-lib generates a
    // random document ID. Both are pinned to the issue; if either regressed,
    // two renders seconds apart would differ.
    const a = await renderCertificate(SNAPSHOT);
    await new Promise((r) => setTimeout(r, 1100));
    const b = await renderCertificate(SNAPSHOT);
    expect(sha(a)).toBe(sha(b));
  });

  it('changes when ANY certified figure changes', async () => {
    const base = sha(await renderCertificate(SNAPSHOT));
    for (const [label, mutation] of [
      ['assigned value', { assignedValue: 99.6735 }],
      ['uncertainty', { expandedUncertainty: 0.5336 }],
      ['coverage factor', { coverageFactor: 3 }],
      ['lot code', { lotCode: 'IPRSPARA0005' }],
      ['issue number', { issueNumber: 2 }],
      ['signer', { issuedByName: 'Somebody Else' }],
      ['expiry', { expiryDate: '2028-04-01' }],
    ] as const) {
      const mutated = sha(await renderCertificate({ ...SNAPSHOT, ...mutation }));
      expect(mutated, `${label} must change the document`).not.toBe(base);
    }
  });

  it('carries a stable document ID derived from content, not chance', async () => {
    const bytes = await renderCertificate(SNAPSHOT);
    const text = Buffer.from(bytes).toString('latin1');
    const ids = [...text.matchAll(/\/ID\s*\[\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)];
    expect(ids.length, 'a document ID must be present').toBeGreaterThan(0);
    expect(ids[0]![1]).toBe(ids[0]![2]);
    expect(ids[0]![1]).toHaveLength(32);
  });
});

describe('the snapshot digest is canonical', () => {
  it('ignores key order', () => {
    // Rebuild with keys in reverse insertion order. (An earlier version of this
    // test passed a sorted key ARRAY to JSON.stringify, which acts as a FILTER
    // and silently dropped every nested key — the test was wrong, not the code.)
    const reordered = Object.fromEntries(
      Object.entries(SNAPSHOT).reverse(),
    ) as unknown as CertificateSnapshot;
    expect(snapshotDigest(reordered)).toBe(snapshotDigest(SNAPSHOT));
  });

  it('changes when a value changes', () => {
    expect(snapshotDigest({ ...SNAPSHOT, assignedValue: 99.6735 }))
      .not.toBe(snapshotDigest(SNAPSHOT));
  });
});

describe('document structure', () => {
  it('embeds its fonts — the base-14 fonts PDF/A forbids are not used', async () => {
    const text = Buffer.from(await renderCertificate(SNAPSHOT)).toString('latin1');
    expect(text, 'the font programme must be embedded').toMatch(/\/FontFile2/);
    expect(text, 'composite fonts, so the full glyph set is available').toMatch(/\/CIDFontType2/);
    for (const base14 of ['/Helvetica', '/Times-Roman', '/Courier']) {
      expect(text, `${base14} must not appear`).not.toContain(base14);
    }
  });

  it('names subsetted fonts with the six-letter prefix PDF/A requires', async () => {
    const text = Buffer.from(await renderCertificate(SNAPSHOT)).toString('latin1');
    const names = [...text.matchAll(/\/BaseFont\s*\/([^\s/\]>]+)/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    // PDF 32000-1 clause 9.6.4: six uppercase letters, a plus, then the base
    // name. pdf-lib emits `DejaVuSerif-1733` on its own; the renderer rewrites
    // it. This assertion previously pinned the GAP — it now pins the fix.
    for (const n of names) {
      expect(n, `${n} must carry a subset prefix`).toMatch(/^[A-Z]{6}\+DejaVu/);
    }
    // Distinct typefaces must get distinct tags, or two subsets that are not
    // interchangeable become indistinguishable to a reader merging documents.
    const tags = new Set(names.map((n) => n.slice(0, 6)));
    expect(tags.size, 'each typeface needs its own tag').toBe(new Set(names).size);
  });

  it('derives subset tags from content, never randomly', async () => {
    // A random tag would be the one thing left in the file that varies between
    // two renders of the same certificate — quietly undoing the property the
    // rest of the renderer exists to protect.
    const tagsOf = async () => {
      const text = Buffer.from(await renderCertificate(SNAPSHOT)).toString('latin1');
      return [...text.matchAll(/\/BaseFont\s*\/([A-Z]{6})\+/g)].map((m) => m[1]!).sort();
    };
    expect(await tagsOf()).toEqual(await tagsOf());
  });

  it('carries XMP metadata', async () => {
    const text = Buffer.from(await renderCertificate(SNAPSHOT)).toString('latin1');
    expect(text).toContain('<x:xmpmeta');
    expect(text).toContain('xmp:CreateDate>2026-08-21T09:15:00Z');
    expect(text).toContain(RENDERER_VERSION);
  });

  it('carries the reproducibility triple in machine-readable metadata', async () => {
    // Page text is encoded through font subsets and cannot be parsed, so the
    // provenance has to live in XMP for a verifier to read it without OCR.
    const text = Buffer.from(await renderCertificate(SNAPSHOT)).toString('latin1');
    expect(text).toContain(`<lotmark:templateKey>${TEMPLATE_KEY}`);
    expect(text).toContain(`<lotmark:rendererVersion>${RENDERER_VERSION}`);
    expect(text).toContain(`<lotmark:snapshotDigest>${snapshotDigest(SNAPSHOT)}`);
    // The custody class is published so nobody mistakes a development key for
    // a hardware module.
    expect(text).toContain('<lotmark:keyCustody>dev_file');
  });

  it('is a real PDF of plausible size', async () => {
    const bytes = await renderCertificate(SNAPSHOT);
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(8_000);
    expect(bytes.byteLength).toBeLessThan(400_000);
  });
});
