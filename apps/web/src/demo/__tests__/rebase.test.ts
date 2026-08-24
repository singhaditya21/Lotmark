import { describe, it, expect } from 'vitest';
import { rebase, deltaFrom } from '../rebase';

/**
 * Moving the recording forward to today.
 *
 * Every case here is about a shape being PRESERVED. The console formats these
 * values differently by field — a date renders as a date, a timestamp as a
 * time — so a rebase that widens `2028-03-31` into an ISO instant renders as
 * midnight on every row, and one that normalises `+05:30` to `Z` moves every
 * displayed time by five and a half hours. Both would look like the product
 * mishandling dates, which is a bad thing to demonstrate.
 */

const DAY = 86_400_000;

describe('shifting dates', () => {
  it('keeps a plain date a plain date', () => {
    expect(rebase('2028-03-31', 2 * DAY)).toBe('2028-04-02');
    expect(rebase('2026-01-01', 0)).toBe('2026-01-01');
  });

  it('keeps a postgres timestamp in its original offset', () => {
    /*
     * `+05:30` must survive. Round-tripping through Date and back would emit
     * UTC, and every time on screen would jump backwards by five and a half
     * hours — which reads as a timezone bug in the product.
     */
    const out = rebase('2026-08-23 23:03:50.284658+05:30', DAY);
    expect(out).toMatch(/\+05:30$/);
    expect(out.startsWith('2026-08-24 23:03:50')).toBe(true);
    expect(out).toContain('.284658');
  });

  it('keeps an ISO instant an ISO instant', () => {
    const out = rebase('2026-08-23T16:53:50.685Z', DAY);
    expect(out).toBe('2026-08-24T16:53:50.685Z');
  });

  it('leaves anything that is not a date alone', () => {
    for (const v of ['CRT-2041', 'RMP-PARA-0421', '99.6734', '', '2026', 'not-a-date']) {
      expect(rebase(v, DAY)).toBe(v);
    }
  });

  it('does not mistake an id for a date', () => {
    // A uuid starts with hex that can look numeric. It must come back untouched.
    const id = '0d48de81-0d8b-5420-ba8e-4de678cbc89f';
    expect(rebase(id, 90 * DAY)).toBe(id);
  });
});

describe('shifting a whole recording', () => {
  it('walks nested structures and preserves everything else', () => {
    const body = {
      entries: [{ seq: '150', occurred_at: '2026-08-23 23:03:50.284658+05:30', kind: 'AUTH' }],
      lot: { lot_code: 'RMP-PARA-0421', expiry_date: '2028-03-31', units: 48, cold: true },
      nothing: null,
    };
    const out = rebase(body, DAY);
    expect(out.entries[0]!.seq).toBe('150');
    expect(out.entries[0]!.kind).toBe('AUTH');
    expect(out.entries[0]!.occurred_at).toContain('2026-08-24');
    expect(out.lot.lot_code).toBe('RMP-PARA-0421');
    expect(out.lot.expiry_date).toBe('2028-04-01');
    expect(out.lot.units).toBe(48);
    expect(out.lot.cold).toBe(true);
    expect(out.nothing).toBeNull();
  });

  it('preserves the INTERVAL between two dates, which is what keeps screens agreeing', () => {
    /*
     * The console derives "expired", "overdue" and "due in N days" from these.
     * Shifting each date independently, or clamping them to a plausible range,
     * produces a lot that is current on one screen and expired on another.
     */
    const before = { issued: '2026-01-01', expires: '2028-03-31' };
    const after = rebase(before, 137 * DAY);
    const gap = (a: string, b: string) =>
      (new Date(b).getTime() - new Date(a).getTime()) / DAY;
    expect(gap(after.issued, after.expires)).toBe(gap(before.issued, before.expires));
  });

  it('is a no-op at zero, without walking anything', () => {
    const body = { a: '2026-01-01' };
    expect(rebase(body, 0)).toBe(body);
  });
});

describe('working out how far to shift', () => {
  it('is the gap between capture and now', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * DAY).toISOString();
    const delta = deltaFrom(twoDaysAgo);
    expect(delta / DAY).toBeCloseTo(2, 1);
  });

  it('is zero when the stamp is missing or unreadable', () => {
    /*
     * A fixture captured by an older script has no stamp. It should still work
     * and simply show its own dates, rather than shifting everything to 1970.
     */
    expect(deltaFrom(undefined)).toBe(0);
    expect(deltaFrom(null)).toBe(0);
    expect(deltaFrom('not a date')).toBe(0);
    expect(deltaFrom(12345)).toBe(0);
  });
});
