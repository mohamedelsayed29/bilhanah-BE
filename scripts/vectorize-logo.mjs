/**
 * Trace the supplied logo locally into two real SVG paths (no embedded bitmap).
 * Install one-time tools outside the application:
 * npm install --prefix /private/tmp/bilhanah-vector-tools potrace@2.1.8 pngjs@7.0.0 --ignore-scripts
 * node scripts/vectorize-logo.mjs /private/tmp/bilhanah-vector-tools
 */
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv[2]) throw new Error('Pass the directory containing the one-time potrace and pngjs tools.');
const require = createRequire(resolve(process.argv[2], 'package.json'));
const { PNG } = require('pngjs');
const { trace } = require('potrace');
const directory = fileURLToPath(new URL('../public/brand/', import.meta.url));
const original = PNG.sync.read(await readFile(resolve(directory, 'bilhanah-logo-original.png')));
const crop = { x: 104, y: 231, width: 1507, height: 479 };
const layers = [
  { color: '#FF7868', includes: (r, g, b) => r > 190 && g < 195 && b < 185 && r > g * 1.3 },
  { color: '#075E54', includes: (r, g, b) => r < 160 && g < 205 && b < 205 && g > r * 1.25 },
];
const paths = [];
for (const layer of layers) {
  const mask = new PNG({ width: crop.width, height: crop.height });
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const source = ((y + crop.y) * original.width + x + crop.x) * 4;
      const target = (y * crop.width + x) * 4;
      const pixel = layer.includes(...original.data.subarray(source, source + 3)) ? 0 : 255;
      mask.data[target] = mask.data[target + 1] = mask.data[target + 2] = pixel;
      mask.data[target + 3] = 255;
    }
  }
  const svg = await new Promise((accept, reject) => trace(PNG.sync.write(mask), {
    threshold: 128, turdSize: 4, alphaMax: 1, optTolerance: 0.15, color: layer.color,
  }, (error, svg) => error ? reject(error) : accept(svg)));
  paths.push(...svg.match(/<path\b[^>]*\/>/g));
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1507" height="479" viewBox="0 0 1507 479" fill="none">
  <title>Bilhanah</title>
  <desc>Vector paths traced locally from the original user-supplied Bilhanah logo. Transparent background; Deep Teal and Guava brand colors.</desc>
  ${paths.join('\n  ')}
</svg>\n`;
await writeFile(resolve(directory, 'bilhanah-logo.svg'), svg);
await writeFile(resolve(directory, 'bilhanah-logo-light.svg'), svg
  .replace('#075E54', '#FFFFFF')
  .replace('Deep Teal and Guava brand colors.', 'White and Guava brand colors for dark backgrounds.'));
console.log(`Created bilhanah-logo.svg: ${paths.length} vector paths, ${Buffer.byteLength(svg)} bytes.`);
