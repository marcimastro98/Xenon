// Puts pictures side by side with a caption over each, in one PNG: a before next to
// an after, or the same tile at several sizes, to look at and to send.
// Run: node tools/widget-look/sheet.mjs <out.png> [--cols 2] [--width 1600] [--round 16] "caption|picture" ...
// Pictures are PNG, WebP or JPEG; each keeps its own shape inside its column. --round
// rounds every picture's corners, for tile shots next to cut-out site pictures.

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const TYPES = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const VALUE_FLAGS = ['--cols', '--width', '--round'];
const USAGE = 'usage: sheet.mjs <out.png> [--cols n] [--width px] [--round px] "caption|picture" ...';

export function parseArgs(argv) {
  const valueOf = (flag, fallback) => { const at = argv.indexOf(flag); return at >= 0 ? Number(argv[at + 1]) : fallback; };
  const rest = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));
  const [out, ...cells] = rest;
  if (!out || !cells.length) throw new Error(USAGE);
  const cols = valueOf('--cols', Math.min(cells.length, 2));
  const width = valueOf('--width', 1600);
  const round = valueOf('--round', 0);
  if (!(cols >= 1) || !(width >= 200) || !(round >= 0)) throw new Error(USAGE);
  return {
    out: path.resolve(out),
    cols,
    width,
    round,
    cells: cells.map((c) => {
      const at = c.indexOf('|');
      return at < 0 ? { caption: '', file: c } : { caption: c.slice(0, at), file: c.slice(at + 1) };
    }),
  };
}

export function mimeOf(file) {
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`${file}: only PNG, WebP or JPEG`);
  return type;
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// cells: [{ caption, src }] with src a data: URI. round clears the corners of a tile's
// shot, which hold the wallpaper behind it, so it sits beside a picture cut out clean.
export function sheetHtml(cells, { cols, width, round = 0 }) {
  const figures = cells.map((c) => `<figure>${c.caption ? `<figcaption>${escape(c.caption)}</figcaption>` : ''}<img src="${escape(c.src)}" alt=""></figure>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#16171c;color:#e9e9ee;font:15px/1.35 "Segoe UI",system-ui,sans-serif}
main{width:${width}px;box-sizing:border-box;padding:20px;display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:20px;align-items:start}
figure{margin:0;display:grid;gap:8px}
figcaption{color:#b9bac4}
img{max-width:100%;height:auto;display:block${round ? `;border-radius:${round}px` : ''}}
</style><main>${figures}</main>`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cells = opts.cells.map((c) => ({ caption: c.caption, src: `data:${mimeOf(c.file)};base64,${readFileSync(c.file).toString('base64')}` }));
  await mkdir(path.dirname(opts.out), { recursive: true });
  const browser = await loadPlaywright().chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: opts.width, height: 400 } });
    try {
      const page = await ctx.newPage();
      await page.setContent(sheetHtml(cells, opts), { waitUntil: 'load' });
      await page.locator('main').screenshot({ path: opts.out });
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(opts.out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
