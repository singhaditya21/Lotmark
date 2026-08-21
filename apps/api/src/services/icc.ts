import { createHash } from 'node:crypto';

/**
 * An sRGB ICC profile, generated rather than vendored.
 *
 * PDF/A-2b requires an OutputIntent naming the colour space the document is
 * prepared for, with the ICC profile EMBEDDED — so a reader years from now can
 * resolve the colours without consulting anything external. That is the whole
 * point of the archival format, and it is the one PDF/A requirement this
 * renderer could not previously meet.
 *
 * ── Why this is built here instead of shipped as a .icc file ────────────────
 *
 * The obvious move is to copy an sRGB profile off the machine — macOS has one
 * at /System/Library/ColorSync/Profiles/sRGB Profile.icc — and check it in.
 * Three problems with that, in ascending order of seriousness:
 *
 *   1. It is Apple's file. Redistributing it inside this repository is a
 *      licensing question nobody here has answered.
 *   2. It would be an unexplained binary in a repository whose entire argument
 *      is that everything on a certificate can be accounted for. "Where did
 *      these 3144 bytes come from" is a question an assessor is entitled to
 *      ask, and "it was on the laptop" is a poor answer.
 *   3. It ties the build to macOS.
 *
 * Generating it makes the profile AUDITABLE SOURCE. Every number below is
 * either from IEC 61966-2-1 (the sRGB standard) or from ICC.1:2001-04 (the v2
 * specification), and the bytes are reproducible on any machine.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 *
 * A certificate must re-render byte-identical years later, so nothing here may
 * vary. The creation timestamp in the header — which the spec says is when the
 * profile was made — is therefore PINNED to a fixed instant rather than taken
 * from the clock. A wall-clock date here would silently make every certificate
 * differ from every other, defeating the property the whole document rests on.
 */

/* ── Primitive writers ────────────────────────────────────────────────────── */

/** ICC s15Fixed16Number: a signed 16.16 fixed-point value. */
function s15f16(raw: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(raw, 0);
  return b;
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v, 0);
  return b;
}

function sig(s: string): Buffer {
  if (s.length !== 4) throw new Error(`ICC signature '${s}' must be exactly 4 bytes.`);
  return Buffer.from(s, 'ascii');
}

/** Tags must begin on a 4-byte boundary; the padding is defined as zero. */
function pad4(b: Buffer): Buffer {
  const over = b.length % 4;
  return over === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - over)]);
}

/* ── Colorimetry ──────────────────────────────────────────────────────────── */

/**
 * sRGB primaries and white point, chromatically adapted to D50.
 *
 * Given as RAW s15Fixed16 integers rather than as decimals that get multiplied
 * by 65536 here. Two reasons: these are the exact values carried by the
 * reference sRGB profiles, so a byte comparison against one of those is
 * meaningful; and a decimal literal would leave the final byte at the mercy of
 * a rounding mode, which is precisely the kind of drift this file exists to
 * eliminate.
 *
 * The PCS is D50 because ICC says the profile connection space is D50 — the
 * adaptation from sRGB's native D65 is baked into these numbers. They have been
 * checked byte-for-byte against the reference profile on this machine, and the
 * sampled transfer curve reproduces its 1024-entry table exactly.
 */
/**
 * The media white point: D50, matching the PCS illuminant.
 *
 * This is a DELIBERATE divergence from the sRGB profile macOS ships, which
 * stores D65 here (0.9505, 1.0000, 1.0891) while carrying D50-adapted
 * primaries — a well-known internal inconsistency in that lineage of profile,
 * tightened up in ICC v4, which requires the media white point of a
 * matrix/TRC display profile to be the PCS illuminant.
 *
 * Our primaries below are byte-identical to that reference profile's, so
 * pairing them with D50 here is the self-consistent reading rather than a
 * different colour space.
 */
const D50_WHITE = [0x0000f6d6, 0x00010000, 0x0000d32d] as const;   // 0.9642, 1.0000, 0.8249
const RED_XYZ   = [0x00006fa2, 0x000038f5, 0x00000390] as const;   // 0.4360, 0.2225, 0.0139
const GREEN_XYZ = [0x00006299, 0x0000b785, 0x000018da] as const;   // 0.3851, 0.7169, 0.0971
const BLUE_XYZ  = [0x000024a0, 0x00000f84, 0x0000b6cf] as const;   // 0.1431, 0.0606, 0.7141

/**
 * The sRGB transfer function, per IEC 61966-2-1.
 *
 * Deliberately the real piecewise curve sampled into a table, NOT a single
 * gamma 2.2 value. A one-entry gamma curve is legal ICC and would make this
 * file a third of the size, but it is an approximation of sRGB rather than
 * sRGB — and a profile that says "sRGB" while describing something else is the
 * same class of overclaim as printing a custody the key does not have.
 */
const TRC_ENTRIES = 1024;

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/* ── Tag builders ─────────────────────────────────────────────────────────── */

function xyzTag(v: readonly [number, number, number]): Buffer {
  return Buffer.concat([
    sig('XYZ '), Buffer.alloc(4),
    s15f16(v[0]), s15f16(v[1]), s15f16(v[2]),
  ]);
}

function curveTag(): Buffer {
  const table = Buffer.alloc(TRC_ENTRIES * 2);
  for (let i = 0; i < TRC_ENTRIES; i++) {
    const linear = srgbToLinear(i / (TRC_ENTRIES - 1));
    // Rounded to the nearest 16-bit code, clamped — Math.round on a value that
    // reaches exactly 1.0 would otherwise produce 65536 and overflow the write.
    const code = Math.min(65535, Math.max(0, Math.round(linear * 65535)));
    table.writeUInt16BE(code, i * 2);
  }
  return Buffer.concat([sig('curv'), Buffer.alloc(4), u32(TRC_ENTRIES), table]);
}

/**
 * textDescriptionType — the ICC v2 shape, which is not simply a string.
 *
 * It carries an ASCII form, a UTF-16 form and a legacy Macintosh ScriptCode
 * form. The Mac block is a fixed 67 bytes whether or not it is used, and
 * omitting it produces a profile that some readers reject. Both alternate
 * forms are left empty, which is what the specification prescribes when only
 * ASCII is available.
 */
function descTag(text: string): Buffer {
  const ascii = Buffer.from(`${text}\0`, 'ascii');
  return Buffer.concat([
    sig('desc'), Buffer.alloc(4),
    u32(ascii.length), ascii,
    u32(0),              // Unicode language code
    u32(0),              // Unicode character count
    Buffer.from([0, 0]), // ScriptCode code
    Buffer.from([0]),    // Macintosh description length
    Buffer.alloc(67),    // the fixed-width Macintosh block
  ]);
}

function textTag(text: string): Buffer {
  return Buffer.concat([sig('text'), Buffer.alloc(4), Buffer.from(`${text}\0`, 'ascii')]);
}

/* ── Assembly ─────────────────────────────────────────────────────────────── */

export const ICC_DESCRIPTION = 'sRGB IEC61966-2.1';

/**
 * Build the profile.
 *
 * The three TRC tags point at ONE copy of the curve. The specification permits
 * several tag entries to share an offset, real profiles do it, and here it
 * saves 4 KB on every certificate ever issued — which for a document that gets
 * stored in a GMP file for a decade is worth the two lines it costs.
 */
function build(): Buffer {
  const bodies: Array<{ tag: string; data: Buffer }> = [
    { tag: 'desc', data: descTag(ICC_DESCRIPTION) },
    { tag: 'wtpt', data: xyzTag(D50_WHITE) },
    { tag: 'rXYZ', data: xyzTag(RED_XYZ) },
    { tag: 'gXYZ', data: xyzTag(GREEN_XYZ) },
    { tag: 'bXYZ', data: xyzTag(BLUE_XYZ) },
    { tag: 'rTRC', data: curveTag() },
    { tag: 'cprt', data: textTag('Generated by Lotmark from IEC 61966-2-1. No rights reserved.') },
  ];

  // gTRC and bTRC are aliases of rTRC rather than copies.
  const SHARED_TRC = 'rTRC';
  const entries: Array<{ tag: string; aliasOf?: string }> = [
    { tag: 'desc' }, { tag: 'wtpt' },
    { tag: 'rXYZ' }, { tag: 'gXYZ' }, { tag: 'bXYZ' },
    { tag: 'rTRC' },
    { tag: 'gTRC', aliasOf: SHARED_TRC },
    { tag: 'bTRC', aliasOf: SHARED_TRC },
    { tag: 'cprt' },
  ];

  const headerSize = 128;
  const tableSize = 4 + entries.length * 12;
  let offset = headerSize + tableSize;

  const placed = new Map<string, { offset: number; size: number }>();
  const chunks: Buffer[] = [];
  for (const body of bodies) {
    placed.set(body.tag, { offset, size: body.data.length });
    const padded = pad4(body.data);
    chunks.push(padded);
    offset += padded.length;
  }

  const table = [u32(entries.length)];
  for (const e of entries) {
    const at = placed.get(e.aliasOf ?? e.tag);
    if (!at) throw new Error(`ICC tag '${e.tag}' has no data.`);
    table.push(sig(e.tag), u32(at.offset), u32(at.size));
  }

  const totalSize = offset;
  const header = Buffer.alloc(headerSize);
  header.writeUInt32BE(totalSize, 0);
  // Preferred CMM is left zero — "any CMM" — which is correct for a profile
  // using only the base v2 tag set. The header is already zero-filled.
  header.writeUInt32BE(0x02100000, 8);          // version 2.1.0
  sig('mntr').copy(header, 12);                 // display device class
  sig('RGB ').copy(header, 16);                 // data colour space
  sig('XYZ ').copy(header, 20);                 // profile connection space

  /**
   * The creation date, PINNED.
   *
   * 2024-01-01T00:00:00Z, chosen once and never changed. The specification
   * wants the moment the profile was created; taking that from the clock would
   * make this profile — and therefore every certificate embedding it —
   * different on every render, which is the one thing a certificate may not be.
   */
  header.writeUInt16BE(2024, 24); // year
  header.writeUInt16BE(1, 26);    // month
  header.writeUInt16BE(1, 28);    // day
  header.writeUInt16BE(0, 30);    // hour
  header.writeUInt16BE(0, 32);    // minute
  header.writeUInt16BE(0, 34);    // second

  sig('acsp').copy(header, 36);   // the file signature every ICC profile carries
  // Primary platform, manufacturer, model, attributes, creator: all left zero.
  header.writeUInt32BE(0, 64);    // rendering intent: perceptual
  s15f16(D50_WHITE[0]).copy(header, 68);
  s15f16(D50_WHITE[1]).copy(header, 72);
  s15f16(D50_WHITE[2]).copy(header, 76);
  // Bytes 84..99 are the profile ID (an MD5 over the profile with certain
  // fields zeroed). Optional in v2 and left zero, which readers accept as
  // "not computed" rather than "computed wrongly".

  return Buffer.concat([header, ...table, ...chunks], totalSize);
}

let cached: Buffer | null = null;

/** The embedded profile. Built once; the bytes never vary. */
export function srgbProfile(): Buffer {
  cached ??= build();
  return cached;
}

/** For the test that pins the profile against accidental change. */
export function srgbProfileDigest(): string {
  return createHash('sha256').update(srgbProfile()).digest('hex');
}

export const ICC_COMPONENTS = 3;
