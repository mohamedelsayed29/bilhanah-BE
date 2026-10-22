import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Supply locally downloaded source clips; the script makes no network requests.
// Source/licensing details are documented in docs/ASSETS.md.
const sourceDirectory = process.argv[2];
if (!sourceDirectory) {
  console.error('Usage: node scripts/build-hero-video.mjs <source-directory>');
  process.exit(1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const media = resolve(root, 'public/media');
mkdirSync(media, { recursive: true });
const clips = [
  { file: 'bilhanah-scan-source.mp4', start: 0, duration: 3.12, posterAt: 2.2, poster: 'scan' },
  { file: 'bilhanah-menu-source.mp4', start: 14, duration: 6, posterAt: 17, poster: 'menu' },
  { file: 'bilhanah-food-source.mp4', start: 2, duration: 5.6, posterAt: 4, poster: 'food' },
];
const run = args => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
for (const clip of clips) {
  if (!existsSync(resolve(sourceDirectory, clip.file))) throw new Error(`Missing source clip: ${clip.file}`);
}
const inputs = clips.flatMap(clip => ['-ss', String(clip.start), '-t', String(clip.duration), '-i', resolve(sourceDirectory, clip.file)]);
// Preserve natural human/hand motion: no still-image loops or synthetic pans.
const filters = clips.map((clip, index) => `[${index}:v]fps=25,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,trim=duration=${clip.duration},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`);
filters.push('[v0][v1]xfade=transition=fade:duration=0.32:offset=2.8[x1]');
filters.push('[x1][v2]xfade=transition=fade:duration=0.32:offset=8.48[out]');
run([...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-metadata', 'comment=Live-action Pexels footage: Gunjee Nyam 5226464; cottonbro studio 5077084 and 6953896. See docs/ASSETS.md.', resolve(media, 'hero-live-v1.mp4')]);
for (const clip of clips) {
  run(['-ss', String(clip.posterAt), '-i', resolve(sourceDirectory, clip.file), '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720', '-q:v', '3', resolve(media, `hero-live-${clip.poster}.jpg`)]);
}
console.log('Created live-action H.264 hero film and three frame-extracted fallback posters.');
