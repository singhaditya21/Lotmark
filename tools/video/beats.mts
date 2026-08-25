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

/**
 * Close whatever modal is open.
 *
 * A native <dialog> opened with showModal() makes the rest of the document
 * INERT, so the navigation is not just visually covered — it is absent from the
 * accessibility tree, and getByRole simply never finds it. Any beat that
 * navigates after a dialog has to close it first.
 */
export async function closeDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const open = modal(page).first();
    if (!await open.isVisible().catch(() => false)) return;
    const close = open.getByRole('button', { name: /^(Close|Done|Cancel)$/ }).last();
    if (await close.isVisible().catch(() => false)) await close.click({ timeout: 2500 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    if (await open.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true, () => false)) return;
    /*
     * Last resort: ask the element itself. A native <dialog> always has close(),
     * and while one is open the rest of the document is inert — so a stuck
     * dialog does not merely cover the navigation, it removes it from the
     * accessibility tree and every later beat fails on a locator that "does not
     * exist".
     */
    await page.evaluate(() => {
      document.querySelectorAll('dialog[open]').forEach((d) => (d as HTMLDialogElement).close());
    }).catch(() => {});
  }
}

/**
 * Publish the open configuration draft.
 *
 * The review dialog stays OPEN when the step-up refuses the act — unlike the
 * signing dialogs, which close themselves — so the retry is another press of
 * the same button, not a re-open. Re-opening finds the dialog still in front of
 * it and stalls on an intercepted click.
 */
export async function publishDraft(page: Page): Promise<void> {
  const press = async () => {
    if (!await modal(page).first().isVisible().catch(() => false)) {
      await page.getByRole('button', { name: /Review and publish/ }).click();
      await modal(page).first().waitFor({ state: 'visible', timeout: 10_000 });
    }
    await modal(page).getByRole('button', { name: /Sign and publish/ }).click();
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
      /*
       * A CAPA move is refused until it says WHY — the confirm button stays
       * disabled while the reason is empty, which is the point of the screen.
       * So the dialog is filled, not just clicked through.
       */
      const move = async () => {
        await page.locator('.capa').first()
          .getByRole('button', { name: /Move to/ }).first().click();
        await modal(page).first().waitFor({ state: 'visible' });
        const step = modal(page).locator('textarea.t').first();
        if (await step.isVisible().catch(() => false)) {
          await step.fill('Logger export reviewed; the excursion is confirmed.');
        }
        await modal(page).locator('input.t').first()
          .fill('Assigned to the Organics section for investigation.');
        await modal(page).getByRole('button', { name: /^Move to|^Close this CAPA/ }).click();
      };
      await move();
      if (await stepUpIfAsked(page)) await move();
      await modal(page).first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
      // Open the history the move just wrote.
      await page.locator('details.capa-history summary').first().click({ timeout: 3000 }).catch(() => {});
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
      if (await stepUpIfAsked(page)) {
        // The ceremony closes the panel's withdraw mode, so it is re-entered
        // rather than blind-clicked: the confirm and the mode button share a
        // label, and clicking the wrong one withdrew twice.
        await modal(page).getByRole('button', { name: /Withdraw issue #\d+…/ })
          .click({ timeout: 3000 }).catch(() => {});
        await modal(page).locator('input.t, textarea.t').first()
          .fill('Homogeneity re-assessment invalidated the assigned value.', { timeout: 3000 })
          .catch(() => {});
        await modal(page).getByRole('button', { name: /^Withdraw issue #\d+$/ })
          .click({ timeout: 3000 }).catch(() => {});
      }
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
      await closeDialogs(page);
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
      await publishDraft(page);
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


/* ── Film: Who may act ───────────────────────────────────────────────────────
 *
 * Permission, competence and belonging are three different things, and the
 * product keeps them apart on purpose. That distinction is too slow for the
 * main film and too important to leave out of the set. */

const PEOPLE: Beat[] = [
  {
    id: '01-three-things',
    act: 'Who may act',
    chapter: 'Who may act',
    script: 'Three things decide whether somebody may do something here, '
      + 'and this platform refuses to conflate them.',
    run: async (page) => {
      await signIn(page, 'admin@producer.example');
      await go(page, /^People$/);
      await page.locator('main table').first().waitFor({ state: 'visible' });
    },
    hold: 2200,
  },
  {
    id: '02-role',
    act: 'Who may act',
    script: 'A role is authority, at a scope. Granting one demands a reason, '
      + 'and the reason is recorded against your account, not theirs.',
    run: async (page) => {
      await page.getByRole('button', { name: 'Grant role' }).first().click();
      await modal(page).first().waitFor({ state: 'visible' });
      await modal(page).locator('select').first().selectOption({ index: 1 });
      await modal(page).locator('input.t').last()
        .fill('Covering the section lead through the September audit.');
    },
    hold: 2500,
  },
  {
    id: '03-dated',
    act: 'Who may act',
    script: 'It can also be dated. Leave cover that depends on somebody remembering '
      + 'to revoke it usually is not revoked — so a dated grant expires on its own.',
    run: async (page) => {
      await modal(page).locator('input[type=date]').first().fill('2026-09-30').catch(() => {});
      await modal(page).getByRole('button', { name: /^Grant$/ }).click();
      await modal(page).first().waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    },
    hold: 2500,
  },
  {
    id: '04-competence',
    act: 'Who may act',
    script: 'Holding the permission is necessary, and not sufficient. '
      + 'ISO seventeen thousand and thirty four also asks whether they are competent to perform it, on the day.',
    run: async (page) => {
      await closeDialogs(page);
      await page.getByRole('button', { name: 'Competence' }).first().click();
      await modal(page).first().waitFor({ state: 'visible' });
      await modal(page).locator('select').first().selectOption({ index: 1 }).catch(() => {});
      const dates = modal(page).locator('input[type=date]');
      await dates.nth(0).fill('2026-01-01').catch(() => {});
      await dates.nth(1).fill('2027-01-01').catch(() => {});
      await modal(page).locator('input.t').last()
        .fill('Witnessed demonstration; assessment record TR-118.');
    },
    hold: 3000,
  },
  {
    id: '05-belonging',
    act: 'Who may act',
    script: 'And membership is simply belonging. It grants nothing at all — '
      + 'it is the scope a role can be granted in.',
    run: async (page) => {
      await modal(page).getByRole('button', { name: /^Record$/ }).click().catch(() => {});
      await closeDialogs(page);
      await page.getByRole('button', { name: /\d+ members?/ }).first().click();
      await modal(page).first().waitFor({ state: 'visible' });
    },
    hold: 3000,
  },
  {
    id: '06-scoped',
    act: 'Who may act',
    script: 'The consequence is visible immediately. The same console, a different person, '
      + 'and the navigation itself is smaller — you cannot open what you do not hold.',
    run: async (page) => {
      await closeDialogs(page);
      await switchTo(page, 'ravi@producer.example');
    },
    hold: 3000,
  },
  {
    id: '07-customer',
    act: 'Who may act',
    script: 'A laboratory customer sees no producer screens whatsoever — '
      + 'only their own catalogue, orders and certificates.',
    run: async (page) => {
      await switchTo(page, 'meera@genpharm.example');
    },
    hold: 3000,
  },
  {
    id: '08-tenant',
    act: 'Who may act',
    script: 'And a second producer runs on the same platform, seeing none of the first. '
      + 'Different laboratory, different materials, different people.',
    run: async (page) => {
      await switchTo(page, 'admin@producer.example');
      await page.getByRole('button', { name: /Switch to/ }).click();
      await page.waitForTimeout(1200);
      await go(page, /^Projects$/).catch(() => {});
    },
    hold: 3500,
  },
];

/* ── Film: Configure without code ────────────────────────────────────────────
 *
 * The designers are the low-code story and the best thing in the product to
 * film — and the main film has no room to stop for them. */

const LOWCODE: Beat[] = [
  {
    id: '01-draft',
    act: 'Configure without code',
    chapter: 'Configure without code',
    script: 'Fields, option lists, layouts and workflows are configuration, not code. '
      + 'They are designed in a draft, and nothing is live until it is signed.',
    run: async (page) => {
      await signIn(page, 'admin@producer.example');
      await go(page, /Form designer/);
      await page.locator('main').waitFor({ state: 'visible' });
    },
    hold: 2500,
  },
  {
    id: '02-field',
    act: 'Configure without code',
    script: 'A new field on a lot: what it is called, what type it takes, whether it is required, '
      + 'and whether it belongs on the certificate.',
    run: async (page) => {
      await page.getByRole('button', { name: 'Add a field' }).click();
      await modal(page).first().waitFor({ state: 'visible' });
      await modal(page).locator('input.t').first().fill('Container seal');
    },
    hold: 3000,
  },
  {
    id: '03-preview',
    act: 'Configure without code',
    script: 'The preview beside it is not a mock-up. It is the same renderer the record screens use, '
      + 'drawing the draft you are editing.',
    run: async (page) => {
      await closeDialogs(page);
      await page.locator('.preview, main').first().waitFor({ state: 'visible' });
    },
    hold: 3000,
  },
  {
    id: '04-layout',
    act: 'Configure without code',
    script: 'A layout decides what is shown and where — and it can be scoped to particular roles, '
      + 'so a dispatcher and a scientist need not see the same form.',
    run: async (page) => {
      await page.getByRole('button', { name: /Arrange these fields|Layout/ }).first()
        .click({ timeout: 5000 }).catch(() => {});
      await page.locator('.lab').first().scrollIntoViewIfNeeded().catch(() => {});
    },
    hold: 3500,
  },
  {
    id: '05-flow',
    act: 'Configure without code',
    script: 'The flow designer does the same for the state machines. '
      + 'These are the moves the server will actually enforce — not a diagram of them.',
    run: async (page) => {
      await go(page, /Flow designer/);
      await page.locator('main').waitFor({ state: 'visible' });
    },
    hold: 3000,
  },
  {
    id: '06-signature',
    act: 'Configure without code',
    script: 'Each move can demand an electronic signature, or a guard condition — '
      + 'and the machine on the right is what the runtime resolved from this draft.',
    run: async (page) => {
      await page.locator('main').first().scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(600);
    },
    hold: 3000,
  },
  {
    id: '07-publish',
    act: 'Configure without code',
    script: 'None of it is live yet. Publishing is a signed act that leaves a numbered version '
      + 'behind — and every record created afterwards is pinned to it.',
    run: async (page) => {
      await go(page, /Configuration/);
      await page.getByRole('button', { name: /Review and publish/ }).click();
      await modal(page).first().waitFor({ state: 'visible' });
    },
    hold: 3000,
  },
  {
    id: '08-published',
    act: 'Configure without code',
    script: 'Which is what makes "under what rules was this certificate issued" '
      + 'a question you can still answer years later.',
    run: async (page) => {
      await publishDraft(page);
      await closeDialogs(page);
    },
    hold: 3500,
  },
];

/* ── Film: Prove it to an assessor ───────────────────────────────────────────
 *
 * What an ISO 17034 assessor actually asks for, and what the platform can hand
 * over without anybody assembling a binder. */

const ASSESSOR: Beat[] = [
  {
    id: '01-clauses',
    act: 'Prove it to an assessor',
    chapter: 'Prove it to an assessor',
    script: 'An assessor arrives with a checklist. This is that checklist, '
      + 'reported from the records rather than from a specification with ticks beside it.',
    run: async (page) => {
      await signIn(page, 'neha@producer.example');
      await go(page, /Conformance/);
      await page.locator('.kpi').first().waitFor({ state: 'visible' });
    },
    hold: 3000,
  },
  {
    id: '02-two-facts',
    act: 'Prove it to an assessor',
    script: 'Each requirement carries two separate facts: what the code enforces, '
      + 'and what the records currently show. They can disagree, and the disagreement is the finding.',
    run: async (page) => {
      await page.locator('main .card').first().scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(600);
    },
    hold: 3500,
  },
  {
    id: '03-gaps',
    act: 'Prove it to an assessor',
    script: 'Nothing here rounds a gap up to a pass. The gaps are counted, '
      + 'and the count is the control that isolates them.',
    run: async (page) => {
      await page.locator('button.kpi').filter({ hasText: /gap/i }).first()
        .click({ timeout: 5000 }).catch(() => {});
    },
    hold: 3500,
  },
  {
    id: '04-pack',
    act: 'Prove it to an assessor',
    script: 'The whole assessment leaves as one signed pack, with a digest — '
      + 'so what was handed over can be checked against what the ledger says was exported.',
    run: async (page) => {
      await page.getByRole('button', { name: /Export the assessment pack/ })
        .click({ timeout: 8000 }).catch(() => {});
      await page.locator('.toast, .note.okbox').first()
        .waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    },
    hold: 3000,
  },
  {
    id: '05-ledger',
    act: 'Prove it to an assessor',
    script: 'Behind it is the ledger. Every act, appended and hash-linked to the one before it.',
    run: async (page) => {
      await go(page, /Audit ledger/);
      await page.locator('.ledger .e').first().waitFor({ state: 'visible' });
    },
    hold: 2500,
  },
  {
    id: '06-three-outcomes',
    act: 'Prove it to an assessor',
    script: 'And verifying it has three outcomes, not two. Intact, broken — '
      + 'or not checked, because a key was rotated and this server no longer holds the old one.',
    run: async (page) => {
      await page.getByRole('button', { name: /Verify the chain/ }).click();
      await page.locator('.note.okbox, .note.warn, .note.deny').first()
        .waitFor({ state: 'visible', timeout: 15_000 });
    },
    hold: 3500,
  },
  {
    id: '07-operations',
    act: 'Prove it to an assessor',
    script: 'The unattended half is reported too. A job that failed every night for a week '
      + 'used to look exactly like one with nothing to do.',
    run: async (page) => {
      await go(page, /Operations/);
      await page.locator('main table').first().waitFor({ state: 'visible' });
    },
    hold: 3000,
  },
  {
    id: '08-drills',
    act: 'Prove it to an assessor',
    script: 'Including the restores. A backup nobody has ever restored is a hypothesis — '
      + 'and this page says so, in as many words, when no drill has been run.',
    run: async (page) => {
      await page.locator('main').first().scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(800);
    },
    hold: 3500,
  },
];

/* ── The films ────────────────────────────────────────────────────────────────
 *
 * `main` is the story: one material from certification to recall. The others
 * are the subjects it cannot stop for without losing its thread — each is a
 * short film in its own right, and they share these helpers and this pipeline.
 */
export const FILMS: Record<string, Beat[]> = {
  main: [...ACT_I, ...ACT_II, ...ACT_III, ...ACT_IV, ...FINALE],
  people: PEOPLE,
  lowcode: LOWCODE,
  assessor: ASSESSOR,
};

/** The film named by $FILM, defaulting to the main one. */
export function pickFilm(name?: string): { name: string; beats: Beat[] } {
  const key = name ?? process.env['FILM'] ?? 'main';
  const beats = FILMS[key];
  if (!beats) {
    throw new Error(`No film "${key}". Try: ${Object.keys(FILMS).join(', ')}`);
  }
  return { name: key, beats };
}
