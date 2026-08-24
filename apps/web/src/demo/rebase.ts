/**
 * Move the recording forward to today.
 *
 * The fixture is captured once and then sits in the repository. Left alone, a
 * demo filmed six months later opens on an audit ledger whose newest entry is
 * six months old, equipment whose calibration lapsed, and lots that expired
 * while nobody was looking. None of that is a fault in the product and all of
 * it is visible on camera.
 *
 * Every date is shifted by the same delta — the gap between capture and load —
 * which is what keeps the data coherent. A certificate issued three days before
 * a lot was released stays three days before it. An expiry eighteen months out
 * stays eighteen months out. Rewriting dates individually, or clamping them to
 * plausible ranges, would break those relationships and the screens that
 * compute from them: the console derives "expired", "overdue" and "due in N
 * days" from these values, so an inconsistent set produces a lot that is both
 * current and expired on two different screens.
 */

/** `2026-08-23` — a plain date, and it must come back as a plain date. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-08-23T16:53:50.685Z` — ISO, as JSON.stringify writes it. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** `2026-08-23 23:03:50.284658+05:30` — how postgres.js hands back a timestamptz. */
const PG = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}:\d{2})$/;

const two = (n: number) => String(n).padStart(2, '0');

/**
 * Shift one string if it is a date, leave it alone otherwise.
 *
 * Returns the SAME shape it was given. That matters more than it sounds: the
 * console formats `expiry_date` as a date and `occurred_at` as a time, and a
 * plain date widened into an ISO timestamp renders as midnight on every row.
 */
function shift(value: string, deltaMs: number): string {
  if (DATE_ONLY.test(value)) {
    const d = new Date(`${value}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return value;
    d.setTime(d.getTime() + deltaMs);
    return d.toISOString().slice(0, 10);
  }

  if (ISO.test(value)) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return new Date(d.getTime() + deltaMs).toISOString();
  }

  const pg = PG.exec(value);
  if (pg) {
    // Reassembled by hand, keeping the original offset, because turning it into
    // a Date and back would rewrite `+05:30` as `Z` and quietly move every
    // displayed time by five and a half hours.
    const [, date, time, frac = '', offset] = pg;
    const d = new Date(`${date}T${time}${frac}${offset}`);
    if (Number.isNaN(d.getTime())) return value;
    const moved = new Date(d.getTime() + deltaMs);

    // Render in the original offset rather than UTC.
    const sign = offset!.startsWith('-') ? -1 : 1;
    const [oh, om] = offset!.slice(1).split(':').map(Number);
    const local = new Date(moved.getTime() + sign * ((oh! * 60 + om!) * 60_000));
    const y = local.getUTCFullYear();
    const stamp = `${y}-${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())} `
      + `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())}`;
    return `${stamp}${frac}${offset}`;
  }

  return value;
}

/** Walk a recorded body, shifting every date-shaped string. */
export function rebase<T>(value: T, deltaMs: number): T {
  if (deltaMs === 0) return value;
  if (typeof value === 'string') return shift(value, deltaMs) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => rebase(v, deltaMs)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [k, rebase(v, deltaMs)]),
    ) as unknown as T;
  }
  return value;
}

/**
 * How far to move everything.
 *
 * Zero when the stamp is missing or unreadable, so a fixture captured by an
 * older script still works and simply shows its own dates.
 */
export function deltaFrom(capturedAt: unknown): number {
  if (typeof capturedAt !== 'string') return 0;
  const t = new Date(capturedAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Date.now() - t;
}
