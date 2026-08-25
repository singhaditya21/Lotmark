/**
 * Speak every beat, and measure it.
 *
 * Narration is synthesised BEFORE anything is recorded, because the audio is
 * what decides how long each shot runs. Once this has written durations.json
 * the recorder knows exactly how long to hold each beat, and the two tracks
 * cannot drift apart.
 *
 * Run: pnpm demo:narrate
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { KokoroTTS } from 'kokoro-js';
import { pickFilm } from './beats.mts';

const { name: FILM, beats: BEATS } = pickFilm();
const BUILD = path.join(import.meta.dirname, 'build', FILM);
const OUT = path.join(BUILD, 'audio');
const VOICE = process.env['VOICE'] ?? 'am_michael';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

mkdirSync(OUT, { recursive: true });

console.log(`Loading ${MODEL} (first run downloads ~90 MB)…`);
const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu' });

/** ffprobe is the authority on how long a file actually is. */
const durationOf = (file: string): number => Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration',
  '-of', 'default=noprint_wrappers=1:nokey=1', file,
]).toString().trim());

const durations: Record<string, number> = {};

for (const beat of BEATS) {
  const file = path.join(OUT, `${beat.id}.wav`);
  const audio = await tts.generate(beat.script, { voice: VOICE });
  await audio.save(file);
  durations[beat.id] = durationOf(file);
  console.log(`  ${beat.id.padEnd(20)} ${durations[beat.id]!.toFixed(2)}s  ${beat.script.slice(0, 58)}…`);
}

writeFileSync(
  path.join(BUILD, 'durations.json'),
  JSON.stringify(durations, null, 2),
);

const total = Object.values(durations).reduce((a, b) => a + b, 0);
console.log(`\n${FILM}: ${BEATS.length} beats · ${total.toFixed(1)}s of narration · voice ${VOICE}`);
console.log(`written to build/${FILM}/durations.json`);
