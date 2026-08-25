/**
 * Drive the demo and capture the picture, beat by beat.
 *
 * ── Why frames and timestamps rather than a video file ──────────────────────
 *
 * Playwright can write the video itself, but its encoder is fixed at VP8, 25
 * fps and about 1 Mbit — which puts visible mosquito noise on a dense console
 * full of small text. So this takes the raw frames instead and lets ffmpeg
 * encode them properly later.
 *
 * That comes with a catch worth stating: the screencast is CHANGE-DRIVEN. While
 * a beat holds still — which is most of the time, because the narration is
 * still speaking — no frames arrive at all. A naive "encode these frames at 30
 * fps" would therefore compress every pause and drift out of sync within
 * seconds. Each frame is stamped with the moment it arrived, and assemble.mts
 * turns those stamps into explicit per-frame durations, so a still second is a
 * still second.
 *
 * Run: pnpm demo:record
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { BEATS } from './beats.mts';

const HERE = import.meta.dirname;
const BUILD = path.join(HERE, 'build');
const FRAMES = path.join(BUILD, 'frames');
const URL = process.env['DEMO_URL'] ?? 'https://singhaditya21.github.io/Lotmark/';
/*
 * 1920x1080 at 1x — captured at exactly the delivery size.
 *
 * Width is set by the NAVIGATION, not the content: a full producer holds
 * thirteen sections and, with a long name beside them, the bar wraps to two
 * lines below 1920 and reads as a broken layout. Capturing at the delivery
 * resolution also means no resampling at all, which is sharper on small text
 * than supersampling and downscaling would be. The console's own max-width of
 * 1180 leaves a margin either side; that is the lesser cost.
 */
const WIDTH = Number(process.env['WIDTH'] ?? 1920);
const HEIGHT = Number(process.env['HEIGHT'] ?? 1080);
const SCALE = Number(process.env['SCALE'] ?? 1);
const ONLY = process.env['ONLY'];

const durationsPath = path.join(BUILD, 'durations.json');
if (!existsSync(durationsPath)) {
  console.error('No build/durations.json — run `pnpm demo:narrate` first.');
  process.exit(1);
}
const durations = JSON.parse(readFileSync(durationsPath, 'utf8')) as Record<string, number>;

const beats = ONLY ? BEATS.filter((b) => b.id.startsWith(ONLY)) : BEATS;
if (beats.length === 0) { console.error(`No beat matches ONLY=${ONLY}`); process.exit(1); }

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: SCALE,
  reducedMotion: 'no-preference',
});
const page = await context.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });

/**
 * Every frame the compositor produced, stamped with wall-clock milliseconds
 * since the take began.
 *
 * Deliberately NOT the CDP `timestamp` the callback also offers: its epoch and
 * unit are an implementation detail, and the beat marks below are wall-clock,
 * so mixing the two would be a units bug waiting to happen. One clock.
 */
const frames: Array<{ file: string; w: number }> = [];
let n = 0;
let t0 = Date.now();

const screencast = await page.screencast.start({
  size: { width: WIDTH * SCALE, height: HEIGHT * SCALE },
  quality: 92,
  onFrame: ({ data }) => {
    const file = path.join(FRAMES, `${String(n++).padStart(6, '0')}.jpg`);
    writeFileSync(file, data);
    frames.push({ file, w: Date.now() - t0 });
  },
});

// The synthetic pointer. Without this the cursor is simply not in the picture —
// the compositor does not contain it — and the app appears to operate itself.
/*
 * The action titles ("Click", "Fill …") default to top-right, where they sit
 * on top of Sign out. Moved to top-left, over the wordmark, which hides no
 * control.
 *
 * NOT suppressed with `duration: 1`, which was the first attempt: that also
 * stops the cursor ANIMATION, and the frame count collapsed from 1326 to 192 —
 * the pointer gliding between targets is most of what makes the film move.
 */
await page.screencast.showActions({ cursor: 'pointer', position: 'top-left' });

/** Remove one overlay, whichever flavour of disposable it turned out to be. */
const dispose = async (o: unknown): Promise<void> => {
  const d = o as { [Symbol.dispose]?: () => void; [Symbol.asyncDispose]?: () => Promise<void> } | undefined;
  try {
    if (d?.[Symbol.asyncDispose]) await d[Symbol.asyncDispose]!();
    else d?.[Symbol.dispose]?.();
  } catch { /* the page navigated and took the overlay with it */ }
};

const marks: Array<{ id: string; act: string; start: number; end: number; audio: number }> = [];
// Reset the clock now that the page is up, so the marks and the frame stamps
// share an origin.
t0 = Date.now();
let currentAct = '';

for (const beat of beats) {
  const audio = durations[beat.id];
  if (audio === undefined) { console.error(`No narration for ${beat.id} — re-run narrate.`); process.exit(1); }

  if (beat.chapter && beat.act !== currentAct) {
    await page.screencast.showChapter(beat.chapter, { duration: 2000 });
    await page.waitForTimeout(2200);
  }
  currentAct = beat.act;

  const start = Date.now() - t0;
  // The caption rides on the page itself — this machine's ffmpeg has no libass,
  // so burning them in later is not an option, and this inherits the app's type.
  const caption = `<div style="position:fixed;left:0;right:0;bottom:0;`
    // Above the demo bar, which is also pinned to the bottom and was covering
    // the caption entirely, and above the app's own stacking contexts.
    + `z-index:2147483647;padding:26px 28px 68px;pointer-events:none;`
    + `background:linear-gradient(transparent,rgba(0,0,0,.86));color:#fff;`
    + `font:500 22px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;`
    + `text-align:center;text-shadow:0 2px 6px rgba(0,0,0,.95)">`
    + `${(beat.caption ?? beat.script).replace(/</g, '&lt;')}</div>`;
  /*
   * showOverlay ADDS an overlay and hands back a disposable that removes it.
   * The earlier code called hideOverlays() at the end of each beat, which only
   * hides the container — so every caption after the first was added into a
   * hidden layer and never appeared. Own the handle, dispose the handle.
   */
  let overlay = await page.screencast.showOverlay(caption);

  try {
    await beat.run(page);
  } catch (e) {
    console.error(`\n✗ ${beat.id} failed: ${(e as Error).message}`);
    await page.screenshot({ path: path.join(BUILD, `fail-${beat.id}.png`) });
    await browser.close();
    process.exit(1);
  }

  /*
   * Overlays and the cursor decoration are injected into the page, so a beat
   * that navigates — signing out to hand over to another persona does a full
   * reload — throws them away mid-shot. Re-applying costs nothing when they
   * survived, and saves the caption when they did not.
   */
  await page.screencast.showActions({ cursor: 'pointer', position: 'top-left' }).catch(() => {});
  await dispose(overlay);
  overlay = await page.screencast.showOverlay(caption);

  // Hold the shot until the narration has finished speaking, plus any tail.
  const target = audio * 1000 + (beat.hold ?? 800);
  const spent = Date.now() - t0 - start;
  if (spent < target) await page.waitForTimeout(target - spent);

  await dispose(overlay);
  marks.push({ id: beat.id, act: beat.act, start, end: Date.now() - t0, audio });
  console.log(`  ${beat.id.padEnd(20)} shot ${((Date.now() - t0 - start) / 1000).toFixed(1)}s `
    + `(narration ${audio.toFixed(1)}s)`);
}

await screencast[Symbol.dispose]?.() ?? await page.screencast.stop();
await browser.close();

writeFileSync(path.join(BUILD, 'marks.json'), JSON.stringify({ frames, marks, width: WIDTH * SCALE, height: HEIGHT * SCALE }, null, 2));
console.log(`\n${frames.length} frames · ${marks.length} beats · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('written to build/marks.json');
