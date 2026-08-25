/**
 * Turn frames, narration and captions into the finished film.
 *
 * The one idea that makes this reliable: each beat is encoded as its own
 * segment whose length is forced to EXACTLY its narration length. Once every
 * segment matches its own audio, concatenating both tracks in the same order
 * cannot drift — there is nothing left to synchronise.
 *
 * Run: pnpm demo:assemble
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const HERE = import.meta.dirname;
const FILM = process.env['FILM'] ?? 'main';
const BUILD = path.join(HERE, 'build', FILM);
const SEGMENTS = path.join(BUILD, 'segments');
const FPS = 30;
// Delivered at 1080p — the 2x capture downscales to it cleanly.
const OUT_W = Number(process.env['OUT_W'] ?? 1920);
const OUT_H = Number(process.env['OUT_H'] ?? 1080);

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

if (!existsSync(path.join(BUILD, 'marks.json'))) {
  console.error(`No build/${FILM}/marks.json — run \`pnpm demo:record\` first.`);
  process.exit(1);
}
const { frames, marks } = JSON.parse(readFileSync(path.join(BUILD, 'marks.json'), 'utf8')) as {
  frames: Array<{ file: string; w: number }>;
  marks: Array<{ id: string; act: string; start: number; end: number; audio: number }>;
};

mkdirSync(SEGMENTS, { recursive: true });

const srt: string[] = [];
const stamp = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:`
    + `${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

let elapsed = 0;
const videoList: string[] = [];
const audioList: string[] = [];

for (const [i, beat] of marks.entries()) {
  const mine = frames.filter((f) => f.w >= beat.start && f.w < beat.end);
  if (mine.length === 0) {
    // Nothing changed on screen during this beat — hold the last frame we saw.
    const previous = frames.filter((f) => f.w < beat.start).pop();
    if (previous) mine.push(previous);
  }
  if (mine.length === 0) { console.error(`No frames for ${beat.id}`); process.exit(1); }

  /*
   * Explicit per-frame durations, derived from when each frame actually
   * arrived. This is what preserves a still pause as a still pause instead of
   * collapsing it — the whole reason the frames carry timestamps.
   */
  const lines: string[] = [];
  for (const [j, f] of mine.entries()) {
    const next = mine[j + 1]?.w ?? beat.end;
    const seconds = Math.max(1 / FPS, (next - f.w) / 1000);
    lines.push(`file '${f.file}'`, `duration ${seconds.toFixed(4)}`);
  }
  // The concat demuxer ignores the final entry's duration unless the file is
  // repeated, so name it twice.
  lines.push(`file '${mine[mine.length - 1]!.file}'`);
  const listFile = path.join(SEGMENTS, `${beat.id}.txt`);
  writeFileSync(listFile, lines.join('\n'));

  /*
   * Force the segment to the narration's length — trimming from the START, not
   * the end.
   *
   * A shot that ran longer than its narration did so because the ACTION took
   * longer: signing in, waiting on a dialog. The narration describes what that
   * action produced, so the seconds worth keeping are the last ones. Keeping
   * the first ones instead put the words "a second producer runs on the same
   * platform" over a half-finished login, with the actual switch trimmed off
   * the end. tpad still extends a shot that came in short.
   */
  const shot = (beat.end - beat.start) / 1000;
  const offset = Math.max(0, shot - beat.audio);
  const out = path.join(SEGMENTS, `${beat.id}.mp4`);
  ff([
    '-f', 'concat', '-safe', '0', '-i', listFile,
    ...(offset > 0.05 ? ['-ss', offset.toFixed(3)] : []),
    '-vf', `tpad=stop_mode=clone:stop_duration=6,fps=${FPS},scale=${OUT_W}:${OUT_H}:flags=lanczos,format=yuv420p`,
    '-t', beat.audio.toFixed(3),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', out,
  ]);

  videoList.push(`file '${out}'`);
  audioList.push(`file '${path.join(BUILD, 'audio', `${beat.id}.wav`)}'`);

  srt.push(
    String(i + 1),
    `${stamp(elapsed)} --> ${stamp(elapsed + beat.audio)}`,
    beat.id, '',
  );
  elapsed += beat.audio;
  console.log(`  ${beat.id.padEnd(20)} ${mine.length.toString().padStart(4)} frames → ${beat.audio.toFixed(2)}s`
    + (offset > 0.05 ? `  (trimmed ${offset.toFixed(1)}s of lead-in)` : ''));
}

writeFileSync(path.join(SEGMENTS, 'video.txt'), videoList.join('\n'));
writeFileSync(path.join(SEGMENTS, 'audio.txt'), audioList.join('\n'));

console.log('\nConcatenating…');
ff(['-f', 'concat', '-safe', '0', '-i', path.join(SEGMENTS, 'video.txt'), '-c', 'copy', path.join(BUILD, 'video.mp4')]);
ff(['-f', 'concat', '-safe', '0', '-i', path.join(SEGMENTS, 'audio.txt'), '-c', 'copy', path.join(BUILD, 'narration.wav')]);

console.log('Muxing…');
const out = path.join(HERE, 'build', `lotmark-${FILM}.mp4`);
ff([
  '-i', path.join(BUILD, 'video.mp4'), '-i', path.join(BUILD, 'narration.wav'),
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out,
]);

writeFileSync(path.join(HERE, 'build', `lotmark-${FILM}.srt`), srt.join('\n'));
console.log(`\n▸ ${out}  (${elapsed.toFixed(1)}s)`);
