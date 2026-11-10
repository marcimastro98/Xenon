// Renders tools/wallpapers/scenes.mjs to server/assets/wallpapers/<name>.webp.
// Run: node tools/wallpapers/build.mjs [name ...]
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { WALLPAPERS } from './scenes.mjs';

const OUT = fileURLToPath(new URL('../../server/assets/wallpapers/', import.meta.url));
// Wide enough for a 4K monitor at 1:1; `cover` crops it for every other screen.
const WIDTH = 3840;
const HEIGHT = 1920;
const QUALITY = 0.8;

async function rasterize(page, svg) {
  const url = await page.evaluate(async ({ source, width, height, quality }) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/webp', quality);
  }, { source: svg, width: WIDTH, height: HEIGHT, quality: QUALITY });
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(WALLPAPERS);
await mkdir(OUT, { recursive: true });
const browser = await loadPlaywright().chromium.launch();
try {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    for (const name of names) {
      if (!WALLPAPERS[name]) throw new Error(`unknown wallpaper: ${name}`);
      const bytes = await rasterize(page, WALLPAPERS[name]);
      await writeFile(path.join(OUT, `${name}.webp`), bytes);
      console.log(`${name}.webp ${Math.round(bytes.length / 1024)} KB`);
    }
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
