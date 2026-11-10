// A sheet with the look of Xenon's What's New: one colour, the name of the thing, one
// line, and a real picture of it. Bit sits under the words.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SIZE } from './plan.mjs';

const file = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const dataOf = (rel, type) => `data:${type};base64,${readFileSync(file(rel)).toString('base64')}`;

export const SHEETS = {
  bit: {
    color: '#ffd75e',
    title: 'Bit',
    line: 'Ask about your PC or your game. Tell it to save a clip and it does.',
    picture: 'docs/images/home/bit-chat.webp',
    box: { left: 1008, top: 56, width: 816, height: 968 },
  },
  maker: {
    color: '#b4a0ff',
    title: 'Xenon Maker',
    line: 'Build your own widgets in the browser without writing code.',
    picture: 'docs/images/home/maker.webp',
    box: { left: 640, top: 140, width: 1280, height: 800 },
  },
};

/** The sheet's page. */
export function sheetHtml(id) {
  const s = SHEETS[id];
  const { left, top, width, height } = s.box;
  const heading = dataOf('server/assets/fonts/sofiasans-sc-latin.woff2', 'font/woff2');
  return `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Heading;font-weight:600 800;src:url("${heading}") format("woff2")}
*{box-sizing:border-box}
html,body{margin:0;width:${SIZE.width}px;height:${SIZE.height}px;overflow:hidden;background:${s.color};color:#141414;font-family:Heading,sans-serif}
.words{position:absolute;left:96px;top:120px;width:${left - 176}px}
h1{margin:0 0 28px;font-size:104px;line-height:1;font-weight:800}
p{margin:0;font-size:36px;line-height:1.28;font-weight:600}
.bit{position:absolute;left:96px;bottom:96px;width:176px;height:176px;image-rendering:pixelated}
.pic{position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;object-fit:contain;object-position:left top}
</style><div class="words"><h1>${s.title}</h1><p>${s.line}</p></div>
<img class="bit" src="${dataOf('docs/images/bit.svg', 'image/svg+xml')}" alt="">
<img class="pic" src="${dataOf(s.picture, 'image/webp')}" alt="">`;
}
