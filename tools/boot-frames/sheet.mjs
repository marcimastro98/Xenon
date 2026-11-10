// A contact sheet of chosen frames from grab.ps1, to read a start-up at a glance.
// usage: node tools/boot-frames/sheet.mjs <frames dir> <out.png> <n,n,n...>
// Frame names are f<number>-<ms>.png: list the sizes to see where the picture changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

export function pickFrames(files, numbers) {
  return numbers.map((number) => {
    const prefix = `f${String(number).padStart(3, '0')}-`;
    const file = files.find((name) => name.startsWith(prefix) && name.endsWith('.png'));
    if (!file) throw new Error(`no frame ${number}`);
    return { file, ms: Number(file.slice(prefix.length, -'.png'.length)) };
  });
}

function cell(dir, { file, ms }) {
  const picture = fs.readFileSync(path.join(dir, file)).toString('base64');
  return `<figure><img src="data:image/png;base64,${picture}"><figcaption>${ms} ms</figcaption></figure>`;
}

async function main([dir, out, list]) {
  if (!dir || !out || !list) throw new Error('usage: sheet.mjs <frames dir> <out.png> <n,n,n...>');
  const frames = pickFrames(fs.readdirSync(dir), list.split(',').map(Number));
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1320, height: 800 } });
  try {
    const page = await context.newPage();
    await page.setContent(`<style>
      body { margin: 8px; background: #444; color: #fff; font: 13px sans-serif;
        display: grid; grid-template-columns: repeat(2, 640px); gap: 8px; }
      figure { margin: 0; }
      img { display: block; width: 640px; }
    </style>${frames.map((frame) => cell(dir, frame)).join('')}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: out, fullPage: true });
  } finally {
    await context.close();
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
