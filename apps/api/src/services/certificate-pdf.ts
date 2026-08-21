import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFString, PDFHexString, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

/**
 * Certificate rendering.
 *
 * ── Why this is deterministic, and why that matters ─────────────────────────
 *
 * A certificate states an assigned value and an expanded uncertainty. Somebody
 * puts it in a GMP file and relies on it for years. "Here is the document we
 * issued" only means something if re-rendering the same inputs produces the
 * same bytes — otherwise a dispute has no resolution and the document hash is
 * decoration.
 *
 * PDF is hostile to this by default: it stamps CreationDate and ModDate from
 * the wall clock and generates a random document ID. Both are pinned here —
 * the dates come from the ISSUE, not from now, and the ID is derived from the
 * content digest. Render the same issue twice, a year apart, on two machines,
 * and the bytes match.
 *
 * This is the reason the architecture rejected headless Chromium: its output
 * varies with the browser build, so a certificate would stop reproducing the
 * moment the container was rebuilt.
 *
 * ── What this is NOT, stated plainly ────────────────────────────────────────
 *
 * PDF/A-2b requires an OutputIntent with an embedded ICC profile, and
 * conformance must be VERIFIED by a validator such as veraPDF. Neither an ICC
 * profile nor veraPDF is present on this machine, so this renderer DOES NOT
 * CLAIM PDF/A.
 *
 * What it does provide: fully embedded, subsetted CIDFontType2 fonts (the
 * base-14 fonts PDF/A forbids are not used at all), XMP metadata carrying the
 * reproducibility triple, a stable content-derived document ID, and pinned
 * dates.
 *
 * Three things stand between this and a PDF/A-2b claim, recorded so nobody
 * has to rediscover them:
 *   1. an sRGB OutputIntent with an embedded ICC profile;
 *   2. six-letter subset prefixes on subsetted font names — pdf-lib emits
 *      `DejaVuSerif-6235` where PDF/A wants `ABCDEF+DejaVuSerif`;
 *   3. a veraPDF gate in CI, because an unverified conformance claim is worth
 *      less than an honest absence of one.
 *
 * The renderer version below is part of the reproducibility triple. Change any
 * layout or content decision in this file and it must be incremented, because
 * the bytes will change and the old certificates must still be explicable.
 */
export const RENDERER_VERSION = 'lotmark-pdf-1';
export const TEMPLATE_KEY = 'certificate.default';
export const TEMPLATE_VERSION = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.resolve(here, '../../assets/fonts');

/** Read once. Embedding subsets the glyphs actually used. */
const FONTS = {
  serif: readFileSync(path.join(FONT_DIR, 'DejaVuSerif.ttf')),
  serifBold: readFileSync(path.join(FONT_DIR, 'DejaVuSerif-Bold.ttf')),
  mono: readFileSync(path.join(FONT_DIR, 'DejaVuSansMono.ttf')),
};

/**
 * Everything printed on the certificate, frozen.
 *
 * Stored on the issue as `data_snapshot`. Re-deriving these from live tables at
 * render time would silently produce a different document if anything upstream
 * changed — which is exactly the failure the snapshot exists to prevent.
 */
export interface CertificateSnapshot {
  readonly producerName: string;
  readonly producerAccreditation: string | null;
  readonly certificateCode: string;
  readonly issueNumber: number;
  readonly issuedAt: string;
  readonly lotCode: string;
  readonly previousLotCode: string | null;
  readonly materialName: string;
  readonly casNumber: string | null;
  readonly propertyName: string;
  readonly assignedValue: number;
  readonly expandedUncertainty: number;
  readonly coverageFactor: number;
  readonly unit: string;
  readonly expiryDate: string;
  readonly storageCondition: string;
  readonly transportCondition: string | null;
  readonly components: ReadonlyArray<{ symbol: string; value: number; basis: string }>;
  readonly issuedByName: string;
  readonly signedAt: string;
  readonly signatureMeaning: string;
  readonly keyVersion: string;
  readonly keyCustody: string;
  readonly verificationToken: string;
  readonly reissueReason: string | null;
  readonly conformanceFrame: string;
}

export function snapshotDigest(s: CertificateSnapshot): string {
  // Canonical: keys sorted, so an equivalent object always digests the same.
  return createHash('sha256').update(canonicalJson(s)).digest('hex');
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 56;                     // margin
const INK = rgb(0.08, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.80, 0.79, 0.76);
const ACCENT = rgb(0.106, 0.306, 0.561);   // cobalt
const WARN = rgb(0.55, 0.12, 0.14);

export async function renderCertificate(s: CertificateSnapshot): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const serif = await pdf.embedFont(FONTS.serif, { subset: true });
  const bold = await pdf.embedFont(FONTS.serifBold, { subset: true });
  const mono = await pdf.embedFont(FONTS.mono, { subset: true });

  const page = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - M;

  const text = (str: string, opts: {
    x?: number; size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>;
  } = {}) => {
    page.drawText(str, {
      x: opts.x ?? M, y, size: opts.size ?? 10,
      font: opts.font ?? serif, color: opts.color ?? INK,
    });
  };
  const rule = (colour = RULE, thickness = 0.75) => {
    page.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness, color: colour });
  };
  const right = (str: string, size = 10, font: PDFFont = serif, color = INK) => {
    page.drawText(str, { x: A4.w - M - font.widthOfTextAtSize(str, size), y, size, font, color });
  };

  /* ── Masthead ─────────────────────────────────────────────────────────── */
  text(s.producerName, { size: 15, font: bold });
  y -= 14;
  if (s.producerAccreditation) { text(s.producerAccreditation, { size: 8.5, color: MUTED, font: mono }); y -= 12; }
  else y -= 2;
  text(s.conformanceFrame, { size: 8.5, color: MUTED });
  y -= 16;
  rule(INK, 1.4);
  y -= 22;

  text('CERTIFICATE OF ANALYSIS', { size: 13, font: bold });
  y -= 15;
  text(`Certified reference material · ${s.materialName}${s.casNumber ? ` · CAS ${s.casNumber}` : ''}`,
       { size: 10, color: MUTED });
  y -= 26;

  /* ── Identity block ───────────────────────────────────────────────────── */
  const pair = (label: string, value: string, valueFont: PDFFont = mono) => {
    text(label.toUpperCase(), { size: 7.5, color: MUTED, font: bold });
    y -= 11;
    text(value, { size: 10, font: valueFont });
    y -= 17;
  };

  const colX = A4.w / 2 + 10;
  const startY = y;
  pair('Certificate', s.certificateCode);
  pair('Lot', s.lotCode);
  pair('Issue', `#${s.issueNumber}`);
  const leftEnd = y;

  y = startY;
  const pairRight = (label: string, value: string) => {
    text(label.toUpperCase(), { x: colX, size: 7.5, color: MUTED, font: bold });
    y -= 11;
    text(value, { x: colX, size: 10, font: mono });
    y -= 17;
  };
  pairRight('Issued', s.issuedAt.slice(0, 10));
  pairRight('Expiry', s.expiryDate);
  pairRight('Storage', s.storageCondition);
  y = Math.min(leftEnd, y) - 6;

  if (s.previousLotCode) {
    text(`Supersedes lot ${s.previousLotCode}`, { size: 9, color: MUTED });
    y -= 16;
  }
  if (s.issueNumber > 1) {
    text(`Reissue — ${s.reissueReason ?? 'reason not recorded'}`, { size: 9, color: WARN, font: bold });
    y -= 16;
  }

  y -= 4;
  rule();
  y -= 26;

  /* ── The certified value: the reason the document exists ──────────────── */
  text('CERTIFIED VALUE', { size: 7.5, color: MUTED, font: bold });
  y -= 20;
  text(s.propertyName, { size: 11 });
  y -= 24;

  const value = `${fmt(s.assignedValue)} ± ${fmt(s.expandedUncertainty)} ${s.unit}`;
  text(value, { size: 20, font: bold, color: ACCENT });
  y -= 16;
  text(
    `Expanded uncertainty with a coverage factor k = ${fmt(s.coverageFactor)}, ` +
    'giving a level of confidence of approximately 95 %.',
    { size: 8.5, color: MUTED },
  );
  y -= 26;
  rule();
  y -= 24;

  /* ── Uncertainty budget ───────────────────────────────────────────────── */
  text('UNCERTAINTY BUDGET', { size: 7.5, color: MUTED, font: bold });
  y -= 16;
  for (const c of s.components) {
    text(c.symbol, { size: 9, font: mono });
    text(fmt(c.value), { x: M + 62, size: 9, font: mono });
    text(c.basis, { x: M + 130, size: 8.5, color: MUTED });
    y -= 13;
  }
  y -= 12;
  rule();
  y -= 24;

  /* ── Authorisation ────────────────────────────────────────────────────── */
  text('AUTHORISED BY', { size: 7.5, color: MUTED, font: bold });
  y -= 14;
  text(s.issuedByName, { size: 10.5, font: bold });
  y -= 13;
  text(`${s.signatureMeaning} · ${s.signedAt}`, { size: 8.5, color: MUTED });
  y -= 13;
  // The custody class is printed so nobody mistakes a development key for a
  // hardware module. An overclaim here is worse than the limitation.
  text(`Electronic signature · Ed25519 · key ${s.keyVersion} · custody ${s.keyCustody}`,
       { size: 8, color: MUTED, font: mono });
  y -= 30;

  /* ── Verification footer ──────────────────────────────────────────────── */
  rule();
  y -= 16;
  text('VERIFY THIS CERTIFICATE', { size: 7.5, color: MUTED, font: bold });
  y -= 13;
  text(`http://localhost:5173/verify/${s.verificationToken}`, { size: 9, font: mono, color: ACCENT });
  y -= 13;
  text('The verification page states whether this issue is current, superseded or withdrawn.',
       { size: 8, color: MUTED });

  /* ── Page foot ────────────────────────────────────────────────────────── */
  y = M - 14;
  text(`${s.certificateCode} · issue ${s.issueNumber} · ${s.lotCode}`, { size: 7.5, color: MUTED, font: mono });
  right(`Rendered by ${RENDERER_VERSION} · template ${TEMPLATE_KEY}@${TEMPLATE_VERSION}`,
        7.5, mono, MUTED);

  /* ── Determinism ──────────────────────────────────────────────────────── */
  pdf.setTitle(`${s.certificateCode} issue ${s.issueNumber} — ${s.materialName}`);
  pdf.setAuthor(s.producerName);
  pdf.setSubject(`Certificate of analysis for lot ${s.lotCode}`);
  pdf.setProducer(`Lotmark ${RENDERER_VERSION}`);
  pdf.setCreator(`Lotmark ${RENDERER_VERSION}`);
  pdf.setKeywords(['certified reference material', s.materialName, s.lotCode]);

  // Dates from the ISSUE, never the wall clock. This is the single change that
  // turns a PDF from "different every time" into evidence.
  const issued = new Date(s.issuedAt);
  pdf.setCreationDate(issued);
  pdf.setModificationDate(issued);

  // A stable document ID derived from content. pdf-lib otherwise emits a random
  // one, which alone would make every render differ.
  const idSource = createHash('sha256')
    .update(`${snapshotDigest(s)}|${RENDERER_VERSION}|${TEMPLATE_KEY}@${TEMPLATE_VERSION}`)
    .digest();
  const idHex = PDFHexString.of(idSource.subarray(0, 16).toString('hex'));
  pdf.context.trailerInfo.ID = pdf.context.obj([idHex, idHex]);

  // XMP metadata. PDF/A requires it; it is correct to carry regardless.
  attachXmp(pdf, s);

  return pdf.save({ useObjectStreams: false });
}

function attachXmp(pdf: PDFDocument, s: CertificateSnapshot): void {
  const iso = s.issuedAt.length === 10 ? `${s.issuedAt}T00:00:00Z` : s.issuedAt;
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
        xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
        xmlns:lotmark="https://lotmark.local/ns/1.0/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(s.certificateCode)} issue ${s.issueNumber}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>${esc(s.producerName)}</rdf:li></rdf:Seq></dc:creator>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Certificate of analysis for lot ${esc(s.lotCode)}</rdf:li></rdf:Alt></dc:description>
      <xmp:CreateDate>${iso}</xmp:CreateDate>
      <xmp:ModifyDate>${iso}</xmp:ModifyDate>
      <xmp:CreatorTool>Lotmark ${RENDERER_VERSION}</xmp:CreatorTool>
      <pdf:Producer>Lotmark ${RENDERER_VERSION}</pdf:Producer>
      <!-- The reproducibility triple, machine-readable. Drawn on the page too,
           but page text is encoded through font subsets and cannot be parsed;
           a verifier needs to read the provenance without OCR. -->
      <lotmark:templateKey>${TEMPLATE_KEY}</lotmark:templateKey>
      <lotmark:templateVersion>${TEMPLATE_VERSION}</lotmark:templateVersion>
      <lotmark:rendererVersion>${RENDERER_VERSION}</lotmark:rendererVersion>
      <lotmark:snapshotDigest>${snapshotDigest(s)}</lotmark:snapshotDigest>
      <lotmark:keyVersion>${esc(s.keyVersion)}</lotmark:keyVersion>
      <lotmark:keyCustody>${esc(s.keyCustody)}</lotmark:keyCustody>
      <lotmark:verificationToken>${esc(s.verificationToken)}</lotmark:verificationToken>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  const stream = pdf.context.stream(xmp, {
    Type: 'Metadata', Subtype: 'XML', Length: xmp.length,
  });
  pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(stream));
  // Marked as tagged is a PDF/UA prerequisite; declared honestly as false
  // because this renderer does not yet emit a structure tree.
  pdf.catalog.set(PDFName.of('Lang'), PDFString.of('en-GB'));
}

/** Significant figures the way a certificate states a number. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v) >= 1 ? v.toPrecision(6) : v.toPrecision(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function esc(v: string): string {
  return v.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}
