import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef,
  PDFString, PDFHexString, PDFNumber,
} from 'pdf-lib';

/**
 * A structural PDF/A-2b conformance check.
 *
 * ── Why this exists, and what it is not ─────────────────────────────────────
 *
 * PDF/A conformance is defined by ISO 19005-2 and verified in practice by
 * veraPDF, which implements the full clause set. veraPDF is a Java application
 * and there is no Java runtime on this machine, so it cannot run here.
 *
 * The tempting response is to declare conformance anyway on the grounds that
 * the renderer was written to the standard. That is an unverified claim on a
 * regulated document, which is exactly the kind of statement this product
 * exists to make impossible elsewhere — it would be no better than printing a
 * key custody the key does not have.
 *
 * So this module verifies the subset of PDF/A-2b that can be verified by
 * reading the file, and REPORTS WHAT IT DID NOT CHECK. A pass here means "every
 * requirement this checker covers is met", never "this file is PDF/A". The
 * distinction is carried in the report rather than left to whoever reads it.
 *
 * The clauses cited are from ISO 19005-2 unless marked otherwise.
 */

export interface PdfaFinding {
  /** The clause or specification reference the requirement comes from. */
  readonly clause: string;
  readonly requirement: string;
  /** What was actually found. */
  readonly detail: string;
}

export interface PdfaReport {
  /**
   * True when every requirement in `checked` is met.
   *
   * Deliberately NOT named `conformsToPdfA`. This checker cannot establish
   * that, and a field with the shorter name would eventually be read as though
   * it could.
   */
  readonly conformsToCheckedSubset: boolean;
  readonly checked: readonly string[];
  readonly findings: readonly PdfaFinding[];
  /** Requirements of PDF/A-2b that this checker does NOT verify. */
  readonly notChecked: readonly string[];
}

/**
 * Requirements deliberately out of scope, listed so a reader of a passing
 * report knows the shape of what remains unverified. Keeping this list beside
 * the checks is what stops the report being read as more than it is.
 */
const NOT_CHECKED: readonly string[] = [
  'Colour: that every colour operator resolves through the OutputIntent (6.2.4)',
  'Transparency: blend mode and soft-mask restrictions (6.2.5)',
  'Fonts: that embedded font programmes are internally well-formed and their glyph coverage is complete (6.3.5)',
  'Fonts: CIDToGIDMap and CIDSystemInfo consistency for composite fonts (6.3.6)',
  'Structure: PDF syntax conformance at the lexical level (6.1)',
  'Annotations and actions beyond the forbidden set checked here (6.5, 6.6)',
  'Optional content configuration (6.10)',
  'Digital signature dictionary constraints (6.7)',
];

function nameOf(v: unknown): string | null {
  return v instanceof PDFName ? v.toString().replace(/^\//, '') : null;
}

export async function checkPdfA2b(bytes: Uint8Array): Promise<PdfaReport> {
  const checked: string[] = [];
  const findings: PdfaFinding[] = [];
  const fail = (clause: string, requirement: string, detail: string) =>
    findings.push({ clause, requirement, detail });

  /* ── 6.1.3 Encryption ─────────────────────────────────────────────────── */
  checked.push('The file is not encrypted (6.1.3)');
  let pdf: PDFDocument;
  try {
    /**
     * Two options here, both load-bearing.
     *
     * `ignoreEncryption: false` makes an encrypted file throw rather than
     * silently succeed — an encrypted archival document is a contradiction.
     *
     * `updateMetadata: false` stops pdf-lib REWRITING the information
     * dictionary as it loads. Its default is to stamp its own Producer and a
     * fresh ModDate on any document it opens, which meant the first version of
     * this checker reported a Producer mismatch it had introduced itself while
     * measuring. A checker that modifies its subject measures nothing.
     */
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch (e) {
    fail('6.1.3', 'The document must not be encrypted',
      e instanceof Error ? e.message : String(e));
    return { conformsToCheckedSubset: false, checked, findings, notChecked: NOT_CHECKED };
  }

  const raw = Buffer.from(bytes).toString('latin1');
  const ctx = pdf.context;
  const deref = (v: unknown): unknown => (v instanceof PDFRef ? ctx.lookup(v) : v);

  /* ── 6.1.2 Version ────────────────────────────────────────────────────── */
  checked.push('The header declares PDF 1.7 or earlier (6.1.2)');
  const header = /^%PDF-(\d)\.(\d)/.exec(raw);
  if (!header) {
    fail('6.1.2', 'The file must begin with a PDF header', 'no %PDF- header found');
  } else {
    const major = Number(header[1]), minor = Number(header[2]);
    if (major > 1 || (major === 1 && minor > 7)) {
      fail('6.1.2', 'PDF/A-2 is defined against PDF 1.7', `header declares ${major}.${minor}`);
    }
  }

  /* ── 6.1.3 File identifier ────────────────────────────────────────────── */
  checked.push('The trailer carries a file identifier (6.1.3)');
  const id = ctx.trailerInfo.ID;
  if (!(id instanceof PDFArray) || id.size() !== 2) {
    fail('6.1.3', 'The trailer must carry a two-element /ID', `found ${id ? id.toString() : 'nothing'}`);
  }

  /* ── 6.2.2 Output intent ──────────────────────────────────────────────── */
  checked.push('An OutputIntent names the colour space, with the ICC profile embedded (6.2.2)');
  const intents = deref(pdf.catalog.get(PDFName.of('OutputIntents')));
  if (!(intents instanceof PDFArray) || intents.size() === 0) {
    fail('6.2.2', 'The catalogue must carry at least one OutputIntent',
      'no OutputIntents array in the document catalogue');
  } else {
    let found = 0;
    for (let i = 0; i < intents.size(); i++) {
      const intent = deref(intents.get(i));
      if (!(intent instanceof PDFDict)) continue;
      if (nameOf(intent.get(PDFName.of('S'))) !== 'GTS_PDFA1') continue;
      found++;
      const profile = deref(intent.get(PDFName.of('DestOutputProfile')));
      if (!(profile instanceof PDFRawStream)) {
        fail('6.2.2', 'DestOutputProfile must be an embedded ICC profile stream',
          'the OutputIntent has no embedded profile');
        continue;
      }
      const contents = profile.getContents();
      // 'acsp' at byte 36 is the signature every ICC profile carries. Checking
      // it catches a stream that is present but is not actually a profile.
      const signature = Buffer.from(contents.subarray(36, 40)).toString('ascii');
      if (signature !== 'acsp') {
        fail('6.2.2', 'The embedded profile must be a valid ICC profile',
          `expected the 'acsp' signature at byte 36, found '${signature}'`);
      }
      const declaredSize = Buffer.from(contents.subarray(0, 4)).readUInt32BE(0);
      if (declaredSize !== contents.length) {
        fail('6.2.2', 'The ICC profile must declare its own true length',
          `header says ${declaredSize} bytes, stream holds ${contents.length}`);
      }
      const n = deref(profile.dict.get(PDFName.of('N')));
      if (!(n instanceof PDFNumber) || n.asNumber() !== 3) {
        fail('6.2.2', 'The profile stream must declare /N matching its colour space',
          `expected /N 3 for an RGB profile, found ${n ? n.toString() : 'nothing'}`);
      }
    }
    if (found === 0) {
      fail('6.2.2', 'An OutputIntent with subtype GTS_PDFA1 is required',
        'OutputIntents exist but none has S = GTS_PDFA1');
    }
  }

  /* ── 6.3 Fonts ────────────────────────────────────────────────────────── */
  checked.push('Every font is embedded; the base-14 fonts are not used (6.3.4)');
  checked.push('Subsetted fonts carry a six-letter prefix, consistent across the font, its descendant and its descriptor (PDF 32000-1 9.6.4)');

  for (const forbidden of ['/Helvetica', '/Times-Roman', '/Times-Bold', '/Courier', '/Symbol', '/ZapfDingbats']) {
    if (raw.includes(forbidden)) {
      fail('6.3.4', 'The standard 14 fonts must not be relied on', `${forbidden} appears in the file`);
    }
  }

  let fontsSeen = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (nameOf(obj.get(PDFName.of('Type'))) !== 'Font') continue;

    const subtype = nameOf(obj.get(PDFName.of('Subtype')));
    // Type0 is the composite wrapper; its descendant carries the descriptor.
    // Checking only the wrapper would miss an unembedded descendant entirely.
    if (subtype === 'Type0') {
      fontsSeen++;
      const base = nameOf(obj.get(PDFName.of('BaseFont'))) ?? '';
      assertSubsetName(base, '6.3.5', fail);

      const descendants = deref(obj.get(PDFName.of('DescendantFonts')));
      if (!(descendants instanceof PDFArray) || descendants.size() === 0) {
        fail('6.3.5', 'A Type0 font must have a descendant CIDFont', `${base} has none`);
        continue;
      }
      const child = deref(descendants.get(0));
      if (!(child instanceof PDFDict)) continue;

      const childBase = nameOf(child.get(PDFName.of('BaseFont'))) ?? '';
      if (childBase !== base) {
        fail('PDF 32000-1 9.6.4', 'A descendant CIDFont must carry the same name as its Type0 parent',
          `parent is ${base}, descendant is ${childBase}`);
      }

      const descriptor = deref(child.get(PDFName.of('FontDescriptor')));
      if (!(descriptor instanceof PDFDict)) {
        fail('6.3.4', 'Every font must have a FontDescriptor', `${base} has none`);
        continue;
      }
      const descriptorName = nameOf(descriptor.get(PDFName.of('FontName'))) ?? '';
      if (descriptorName !== base) {
        fail('PDF 32000-1 9.6.4', 'A FontDescriptor must name the same subset as its font',
          `font is ${base}, descriptor is ${descriptorName}`);
      }
      // The embedded programme itself. Its absence is the single most common
      // reason a PDF fails PDF/A, and the one that makes a document unreadable
      // once the machine that rendered it is gone.
      const embedded = ['FontFile', 'FontFile2', 'FontFile3']
        .some((k) => descriptor.get(PDFName.of(k)) !== undefined);
      if (!embedded) {
        fail('6.3.4', 'The font programme must be embedded', `${base} is referenced but not embedded`);
      }
    }
  }
  if (fontsSeen === 0) {
    fail('6.3.4', 'The document should embed the fonts it draws with', 'no composite fonts found');
  }

  /* ── 6.6.2.3 / 6.9 Forbidden features ─────────────────────────────────── */
  checked.push('No JavaScript, launch actions, or embedded-file attachments (6.6.1, 6.9)');
  const names = deref(pdf.catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict) {
    for (const key of ['JavaScript', 'EmbeddedFiles']) {
      if (names.get(PDFName.of(key)) !== undefined) {
        fail('6.6.1', `A conforming file must not carry /${key}`, `found /${key} in the name tree`);
      }
    }
  }
  if (pdf.catalog.get(PDFName.of('AA')) !== undefined) {
    fail('6.6.2', 'The catalogue must not carry an additional-actions dictionary', 'found /AA');
  }
  for (const action of ['/JavaScript', '/Launch', '/Movie', '/ResetForm', '/ImportData']) {
    if (raw.includes(`/S ${action}`) || raw.includes(`/S${action}`)) {
      fail('6.6.1', 'Forbidden action type', `${action} appears in the file`);
    }
  }

  /* ── 6.7.3 Metadata ───────────────────────────────────────────────────── */
  checked.push('XMP metadata is present, uncompressed, and declares PDF/A identification (6.7.2, 6.7.3)');
  const metadata = deref(pdf.catalog.get(PDFName.of('Metadata')));
  if (!(metadata instanceof PDFRawStream)) {
    fail('6.7.2', 'The catalogue must carry an XMP metadata stream', 'no /Metadata in the catalogue');
  } else {
    if (metadata.dict.get(PDFName.of('Filter')) !== undefined) {
      // A compressed metadata stream cannot be read by a tool that does not
      // parse PDF, which is the reason the standard requires it in the clear.
      fail('6.7.2', 'The XMP metadata stream must not be filtered', 'found a /Filter on /Metadata');
    }
    const xmp = Buffer.from(metadata.getContents()).toString('utf8');
    const part = /<pdfaid:part>\s*(\d+)\s*<\/pdfaid:part>/.exec(xmp);
    const conformance = /<pdfaid:conformance>\s*([AB])\s*<\/pdfaid:conformance>/.exec(xmp);
    if (!part) {
      fail('6.7.3', 'XMP must declare pdfaid:part', 'no pdfaid:part in the metadata');
    } else if (part[1] !== '2') {
      fail('6.7.3', 'This document claims PDF/A-2', `pdfaid:part declares ${part[1]}`);
    }
    if (!conformance) {
      fail('6.7.3', 'XMP must declare pdfaid:conformance', 'no pdfaid:conformance in the metadata');
    } else if (conformance[1] !== 'B') {
      fail('6.7.3', 'This document claims conformance level B', `declares level ${conformance[1]}`);
    }

    /**
     * 6.7.3 — the document information dictionary and XMP must agree.
     *
     * They are two copies of the same facts, and a document whose two copies
     * disagree gives a reader no way to decide which is true. This is a real
     * failure mode rather than a theoretical one: setTitle() and the XMP
     * template are written in different places in the renderer, and nothing
     * but this check couples them.
     */
    const info = deref(ctx.trailerInfo.Info);
    if (info instanceof PDFDict) {
      const infoText = (key: string): string | null => {
        const v = deref(info.get(PDFName.of(key)));
        if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
        return null;
      };
      const xmpText = (tag: string): string | null => {
        const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xmp);
        if (!m) return null;
        const inner = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(m[1]!);
        return (inner ? inner[1]! : m[1]!).trim();
      };
      const unescape = (v: string) =>
        v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

      for (const [infoKey, xmpTag] of [['Title', 'dc:title'], ['Producer', 'pdf:Producer']] as const) {
        const a = infoText(infoKey);
        const b = xmpText(xmpTag);
        if (a !== null && b !== null && a !== unescape(b)) {
          fail('6.7.3', `The document information ${infoKey} must agree with XMP ${xmpTag}`,
            `Info says '${a}', XMP says '${unescape(b)}'`);
        }
      }
    }
  }

  return {
    conformsToCheckedSubset: findings.length === 0,
    checked,
    findings,
    notChecked: NOT_CHECKED,
  };
}

function assertSubsetName(
  base: string,
  clause: string,
  fail: (clause: string, requirement: string, detail: string) => void,
): void {
  if (!/^[A-Z]{6}\+/.test(base)) {
    fail(clause, 'A subsetted font name must be six uppercase letters, a plus sign, then the base name',
      `found '${base}'`);
  }
}

/** A one-screen summary, for a CI gate or an operator. */
export function formatReport(report: PdfaReport): string {
  const lines: string[] = [];
  lines.push(report.conformsToCheckedSubset
    ? `PASS — ${report.checked.length} checked requirement(s) met`
    : `FAIL — ${report.findings.length} finding(s)`);
  for (const f of report.findings) {
    lines.push(`  ✗ [${f.clause}] ${f.requirement}`);
    lines.push(`      ${f.detail}`);
  }
  lines.push('', 'Checked:');
  for (const c of report.checked) lines.push(`  · ${c}`);
  lines.push('', 'NOT checked by this tool — run veraPDF for these:');
  for (const c of report.notChecked) lines.push(`  · ${c}`);
  return lines.join('\n');
}
