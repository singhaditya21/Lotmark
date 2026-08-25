import type { Page } from 'playwright';

/**
 * The beat table — the one source of truth for the demo film.
 *
 * Each beat carries its narration AND the click-path that narration describes,
 * so the two cannot drift. Everything downstream is derived from this file:
 * narrate.mts speaks `script` and measures how long it takes, record.mts runs
 * `run` and holds the picture for exactly that long, and assemble.mts stitches
 * the result. Sync is therefore structural rather than something to nudge.
 *
 * Keep each `script` to one or two short sentences. The voice is synthetic and
 * long sentences expose it — and a beat is one idea anyway.
 */

export interface Beat {
  /** Stable id — names the audio, video and caption files for this beat. */
  readonly id: string;
  /** Act title. The first beat of each act gets a chapter card. */
  readonly act: string;
  /** Shown as a chapter card before this beat, when set. */
  readonly chapter?: string;
  /** What the voice says. Also the caption, unless `caption` overrides it. */
  readonly script: string;
  readonly caption?: string;
  /** The UI action this beat narrates. */
  readonly run: (page: Page) => Promise<void>;
  /** Extra milliseconds to hold after the action, for a beat that needs to land. */
  readonly hold?: number;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const PASSWORD = 'demo-viewer';

/** The open modal, whichever it is. */
const modal = (page: Page) => page.locator('dialog.modal[open]');

/** Sign in as a persona. The demo takes any six digits at the second factor. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  const code = page.locator('input[inputmode=numeric]');
  await code.waitFor({ state: 'visible', timeout: 10_000 });
  await code.fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.locator('header.top').waitFor({ state: 'visible', timeout: 15_000 });
}

/** Sign out and back in as somebody else — the persona hand-off. */
export async function switchTo(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.locator('input[type=email]').waitFor({ state: 'visible', timeout: 15_000 });
  await signIn(page, email);
}

/** Open a section from the top navigation. */
export const go = (page: Page, section: string | RegExp) =>
  page.locator('header.top nav').getByRole('button', { name: section }).click();

/**
 * Complete the signing ceremony if it appears.
 *
 * The first signed act in a session opens a step-up dialog and closes the one
 * that triggered it — so the caller retries. Later acts in the same session go
 * straight through, which is the 21 CFR 11 rhythm and not a bug.
 */
export async function stepUpIfAsked(page: Page, waitMs = 3000): Promise<boolean> {
  const dialog = page.locator('dialog[open]', { hasText: 'Confirm your identity' }).first();
  // WAIT for it rather than asking whether it is there yet. The refusal is a
  // server round trip, so a bare isVisible() check races it and reports false —
  // which left the ceremony open and every later click intercepted by it.
  try {
    await dialog.waitFor({ state: 'visible', timeout: waitMs });
  } catch {
    return false;
  }
  await dialog.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await dialog.locator('input[autocomplete="one-time-code"]').fill('123456');
  await dialog.getByRole('button', { name: 'Open signing session' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  return true;
}

/**
 * Perform a signed act, ceremony and all.
 *
 * The first signed act in a session is refused and replaced by the step-up
 * dialog, which also closes the dialog that triggered it — so the act has to be
 * repeated once the signing session is open. That two-attempt rhythm is the
 * product's, not a flake, and every signed beat goes through here.
 */
export async function signedAction(
  page: Page, open: () => Promise<void>, confirm: string | RegExp = 'Sign',
): Promise<void> {
  const press = async () => {
    await open();
    await modal(page).first().waitFor({ state: 'visible', timeout: 10_000 });
    await modal(page).first().getByRole('button', { name: confirm, exact: typeof confirm === 'string' }).click();
  };
  await press();
  if (await stepUpIfAsked(page)) await press();
  await modal(page).first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
}

/* ── Act I — Certify ─────────────────────────────────────────────────────── */

const ACT_I: Beat[] = [
  {
    id: '01-home',
    act: 'Act I — Certify',
    chapter: 'Certify',
    script: 'This is Lotmark, a platform for producers of certified reference materials. '
      + 'A scientist signs in, and the console opens on their own work.',
    run: async (page) => {
      await signIn(page, 'ravi@producer.example');
    },
    hold: 1200,
  },
  {
    id: '02-attention',
    act: 'Act I — Certify',
    script: 'Two things are waiting: studies that need his signature. '
      + 'Nothing here is a to-do list somebody typed. It is the work itself.',
    run: async (page) => {
      await page.locator('.kpi').first().waitFor({ state: 'visible' });
      await page.locator('main table tbody tr').first().hover();
    },
    hold: 1500,
  },
  {
    id: '03-open-study',
    act: 'Act I — Certify',
    script: 'He opens the paracetamol project and finds the study still in draft.',
    run: async (page) => {
      await go(page, /^Projects$/);
      await page.getByRole('button', { name: /PRJ-0412/ }).click();
      await page.getByRole('row', { name: /ST-1014/ }).waitFor({ state: 'visible' });
    },
    hold: 1000,
  },
  {
    id: '04-sign-ceremony',
    act: 'Act I — Certify',
    script: 'Signing it is not a click. The system asks him to prove who he is, '
      + 'with his password and a fresh authenticator code.',
    run: async (page) => {
      await page.getByRole('row', { name: /ST-1014/ }).getByRole('button', { name: 'Sign', exact: true }).click();
      await modal(page).waitFor({ state: 'visible' });
      await modal(page).getByRole('button', { name: 'Sign', exact: true }).click();
      await page.locator('dialog[open]', { hasText: 'Confirm your identity' })
        .waitFor({ state: 'visible', timeout: 10_000 });
    },
    hold: 2000,
  },
  {
    id: '05-signed',
    act: 'Act I — Certify',
    script: 'That is twenty one C F R part eleven: a signature needs a fresh authentication, '
      + 'not just a live session. Now the study is signed, and it says who signed it and when.',
    run: async (page) => {
      await stepUpIfAsked(page);
      await page.getByRole('row', { name: /ST-1014/ }).getByRole('button', { name: 'Sign', exact: true }).click();
      await modal(page).waitFor({ state: 'visible' });
      await modal(page).locator('input.t[placeholder]').fill('Measurements reviewed and accepted.');
      await modal(page).getByRole('button', { name: 'Sign', exact: true }).click();
      await page.getByRole('row', { name: /ST-1014.*signed/ }).waitFor({ timeout: 10_000 });
    },
    hold: 2000,
  },
  {
    // Split from the authorise beat: signing out and back in takes six seconds,
    // which swallowed the narration about four eyes before the action it
    // describes had even started. A hand-off is its own beat.
    id: '06-handoff',
    act: 'Act I — Certify',
    script: 'The scientist has done their part. Now somebody else takes over.',
    run: async (page) => {
      await switchTo(page, 'admin@producer.example');
      await go(page, /^Projects$/);
      await page.getByRole('button', { name: /PRJ-0412/ }).click();
      await page.getByRole('row', { name: /PV-02/ }).waitFor({ state: 'visible' });
    },
    hold: 800,
  },
  {
    id: '07-authorise',
    act: 'Act I — Certify',
    script: 'A second person authorises the certified value. '
      + 'Whoever assigns a value never authorises it — four eyes, enforced by the server.',
    run: async (page) => {
      await signedAction(page, () =>
        page.getByRole('row', { name: /PV-02/ }).getByRole('button', { name: 'Authorise' }).click());
    },
    hold: 1500,
  },
  {
    id: '08-release',
    act: 'Act I — Certify',
    script: 'With an authorised value, a lot can be released. '
      + 'It takes its own number and supersedes the batch before it.',
    run: async (page) => {
      const fill = async () => {
        await page.getByRole('button', { name: 'Release a lot' }).click();
        await modal(page).first().waitFor({ state: 'visible' });
        await modal(page).locator('input[type=date]').fill('2029-06-30');
        const numbers = modal(page).locator('input[type=number]');
        await numbers.nth(0).fill('40');
        await numbers.nth(1).fill('5000');
      };
      await signedAction(page, fill, /Sign and release/);
    },
    hold: 2200,
  },
  {
    id: '09-certificate',
    act: 'Act I — Certify',
    script: 'And the lot gets its certificate — the document a laboratory will one day '
      + 'hold in its hands and want to check.',
    run: async (page) => {
      await signedAction(page, () =>
        page.getByRole('button', { name: 'Issue certificate' }).first().click());
    },
    hold: 2500,
  },
];


/* ── Act II — Sell ───────────────────────────────────────────────────────── */

const ACT_II: Beat[] = [
  {
    id: '10-buyer',
    act: 'Act II — Sell',
    chapter: 'Sell',
    script: 'A laboratory buys that material. She signs in to the same platform '
      + 'and sees an entirely different world — her own.',
    run: async (page) => {
      await switchTo(page, 'meera@genpharm.example');
    },
    hold: 1800,
  },
  {
    id: '11-order',
    act: 'Act II — Sell',
    script: 'The catalogue carries only released lots with an authorised value, '
      + 'each with its certificate. She orders two units.',
    run: async (page) => {
      await page.locator('input[type=number]').first().fill('2');
      await page.getByRole('button', { name: 'Place order' }).click();
      await page.locator('.toast').first().waitFor({ state: 'visible', timeout: 10_000 });
    },
    hold: 2500,
  },
  {
    id: '12-dispatch',
    act: 'Act II — Sell',
    script: 'On the producer side, dispatch packs it and sends it. '
      + 'A courier and a tracking reference are attached as it goes.',
    run: async (page) => {
      await switchTo(page, 'vikram@producer.example');
      await go(page, /Orders/);
      await page.getByRole('button', { name: 'packed', exact: true }).first().click();
      await page.getByRole('button', { name: 'dispatched', exact: true }).first()
        .waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByRole('button', { name: 'dispatched', exact: true }).first().click();
    },
    hold: 2500,
  },
  {
    id: '13-excursion',
    act: 'Act II — Sell',
    script: 'This material ships between two and eight degrees. '
      + 'The logger comes back with a reading at fourteen.',
    run: async (page) => {
      await page.getByRole('button', { name: 'readings' }).first().click();
      await modal(page).first().waitFor({ state: 'visible' });
      await modal(page).locator('textarea').fill('2026-08-25T09:00:00Z, 14.2');
      await modal(page).getByRole('button', { name: 'Record', exact: true }).click();
      await page.locator('.toast').first().waitFor({ state: 'visible', timeout: 10_000 });
    },
    hold: 3500,
  },
];

/* ── Act III — Fail well ─────────────────────────────────────────────────── */

const ACT_III: Beat[] = [
  {
    id: '14-capa-raised',
    act: 'Act III — Fail well',
    chapter: 'Fail well',
    script: 'Nobody had to notice that. The excursion raised a corrective action by itself, '
      + 'because the readings are data rather than a document somebody files.',
    run: async (page) => {
      await switchTo(page, 'neha@producer.example');
      await go(page, /Complaints/);
      await page.locator('.capa').first().waitFor({ state: 'visible' });
    },
    hold: 2500,
  },
  {
    id: '15-investigate',
    act: 'Act III — Fail well',
    script: 'Quality moves it into investigation. Every move is signed, states why, '
      + 'and joins a history the card carries with it.',
    run: async (page) => {
      const card = page.locator('.capa').first();
      await signedAction(page,
        () => card.getByRole('button', { name: /Move to/ }).first().click(),
        /^Move|^Record|^Confirm/);
      await page.locator('details.capa-history').first().click().catch(() => {});
    },
    hold: 3000,
  },
  {
    id: '16-withdraw',
    act: 'Act III — Fail well',
    script: 'And if the material itself is in doubt, its certificate is withdrawn — '
      + 'and every laboratory holding it is told.',
    run: async (page) => {
      await switchTo(page, 'admin@producer.example');
      await go(page, /^Projects$/);
      await page.getByRole('button', { name: /PRJ-0412/ }).click();
      await page.getByRole('button', { name: /Issues & reissue/ }).first().click();
      await modal(page).first().waitFor({ state: 'visible' });
      await modal(page).getByRole('button', { name: /Withdraw issue/ }).click();
      await modal(page).locator('input.t, textarea.t').first()
        .fill('Homogeneity re-assessment invalidated the assigned value.');
      await modal(page).getByRole('button', { name: /^Withdraw issue/ }).click();
      await stepUpIfAsked(page);
      await modal(page).getByRole('button', { name: /^Withdraw issue/ }).click().catch(() => {});
    },
    hold: 3000,
  },
];

/* ── Act IV — Prove it ───────────────────────────────────────────────────── */

const ACT_IV: Beat[] = [
  {
    id: '17-ledger',
    act: 'Act IV — Prove it',
    chapter: 'Prove it',
    script: 'Everything you have just watched is in the ledger — every act, '
      + 'under the person who did it.',
    run: async (page) => {
      await modal(page).first().getByRole('button', { name: 'Close' }).click().catch(() => {});
      await go(page, /Audit ledger/);
      await page.locator('.ledger .e').first().waitFor({ state: 'visible' });
    },
    hold: 2000,
  },
  {
    id: '18-verify-chain',
    act: 'Act IV — Prove it',
    script: 'Each entry is hash-linked to the one before it. Removing or altering one '
      + 'breaks every link that follows, and the console will say so.',
    run: async (page) => {
      await page.getByRole('button', { name: /Verify the chain/ }).click();
      await page.locator('.note.okbox, .note.warn, .note.deny').first()
        .waitFor({ state: 'visible', timeout: 15_000 });
    },
    hold: 3000,
  },
  {
    id: '19-config',
    act: 'Act IV — Prove it',
    script: 'Even the configuration changes under signature. '
      + 'A draft is reviewed, signed, and becomes a numbered version records are pinned to.',
    run: async (page) => {
      await go(page, /Configuration/);
      await page.getByRole('button', { name: /Review and publish/ }).click();
      await modal(page).first().waitFor({ state: 'visible' });
      await modal(page).getByRole('button', { name: /Sign and publish/ }).click();
      if (await stepUpIfAsked(page)) {
        await page.getByRole('button', { name: /Review and publish/ }).click();
        await modal(page).first().waitFor({ state: 'visible' });
        await modal(page).getByRole('button', { name: /Sign and publish/ }).click();
      }
    },
    hold: 3000,
  },
];

/* ── The closing shot ────────────────────────────────────────────────────────
 *
 * Deliberately last. It leaves the console for the public page, and the demo
 * rebuilds its state from the fixture on any page load — so anything recorded
 * after this would start from a blank slate. */

const FINALE: Beat[] = [
  {
    id: '20-public-verify',
    act: 'Finale',
    script: 'And the certificate can be checked by anyone holding it. No account, no login — '
      + 'an assessor with a printed certificate should not need one.',
    run: async (page) => {
      const base = new globalThis.URL(page.url());
      await page.goto(`${base.origin}${base.pathname.replace(/\/$/, '')}/verify/p5Sl5-u5OXZ5Snb-7gDAIjiD`,
        { waitUntil: 'networkidle' });
      await page.getByText(/WITHDRAWN/i).first().waitFor({ state: 'visible', timeout: 15_000 });
    },
    hold: 4000,
  },
];

export const BEATS: Beat[] = [...ACT_I, ...ACT_II, ...ACT_III, ...ACT_IV, ...FINALE];

export const ACTS = [...new Set(BEATS.map((b) => b.act))];
