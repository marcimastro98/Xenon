// The Maker sheet's moving picture: the real Maker, on a dev server of its own
// (`npm run dev -- --port 5183 --strictPort` in ../xenon-maker), changing a
// template by hand. Frames come from the browser's screencast, not its video
// recorder: that one blurs small text.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const CLIP = { width: 960, height: 920, fps: 30 };
const VIEWPORT = { width: 1180, height: 1130 };

// The stills, from the real editor rather than the clip, so small text stays sharp.
export const STILLS = [
  // The Create page's, shot larger than it is kept.
  { file: 'maker-still.webp', viewport: { width: 1280, height: 960 }, scale: 1.5, size: { width: 960, height: 720 } },
  // The Store sheet's, at the size of its box in tools/store-shots/sheet.mjs.
  { file: 'maker.webp', viewport: { width: 1280, height: 800 }, scale: 1, size: { width: 1280, height: 800 } },
];
const HOLD_LAST_S = 1.2;
const CURSOR_STEPS = 22;
const TYPE_DELAY_MS = 95;

// The Maker has no cursor in a recording: this draws one, and a ring on a press.
export const CURSOR = `addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;width:20px;height:20px;pointer-events:none;transform:translate(640px,700px)';
  c.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20"><path d="M3 1v15l4-4 3 7 3-1-3-7h6z" fill="#111" stroke="#fff" stroke-width="1.4"/></svg>';
  document.documentElement.append(c);
  addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
});`;

/** ffmpeg concat list: each frame lasts until the next one, the last one holds. */
export function concatList(frames, holdLast = HOLD_LAST_S) {
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const next = frames[i + 1];
    const seconds = next ? Math.max(0.001, next.at - f.at) : holdLast;
    lines.push(`file '${f.file.replaceAll(path.sep, '/')}'`, `duration ${seconds.toFixed(3)}`);
  });
  // The concat reader ignores the last duration unless the file comes again.
  if (frames.length) lines.push(`file '${frames[frames.length - 1].file.replaceAll(path.sep, '/')}'`);
  return lines.join('\n') + '\n';
}

export function encodeArgs(list, out, clip = CLIP) {
  return ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=${clip.fps},scale=${clip.width}:${clip.height}:flags=lanczos,format=yuv420p`, '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', out];
}

export function stillArgs(png, out, still) {
  return ['-y', '-v', 'error', '-i', png,
    '-vf', `scale=${still.size.width}:${still.size.height}:flags=lanczos`,
    '-c:v', 'libwebp', '-quality', '88', out];
}

async function moveTo(page, target) {
  const box = await target.boundingBox();
  if (!box) throw new Error('nothing to point at');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: CURSOR_STEPS });
  return { x, y };
}

async function press(page, target, pause = 700) {
  await moveTo(page, target);
  await page.waitForTimeout(140);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(pause);
}

/** At this width the sizes sit in their list, so the cursor goes to it. */
async function pickSize(page, size, pause) {
  const list = page.locator('select.sizesel');
  await moveTo(page, list);
  await page.waitForTimeout(140);
  await list.selectOption(size);
  await page.waitForTimeout(pause);
}

/** What the clip shows: a size, a tile shape, the title restyled, then Install. */
async function play(page) {
  const inspector = page.locator('.insp');
  await page.waitForTimeout(700);
  await pickSize(page, 'l', 700);
  await pickSize(page, 'm', 500);
  await press(page, inspector.locator('button.sh').nth(1), 900);
  await press(page, inspector.locator('button.sh').nth(7), 900);
  await press(page, page.locator('aside.left div.row', { hasText: 'Next events' }).nth(1), 600);
  await press(page, inspector.getByRole('button', { name: 'Center', exact: true }).first(), 700);
  await press(page, inspector.locator('input.mono').first(), 200);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('34', { delay: TYPE_DELAY_MS });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await moveTo(page, page.getByRole('button', { name: 'Install in Xenon', exact: true }));
  await page.waitForTimeout(600);
}

/** The Weather template with its big reading picked: the type controls on show. */
export async function shootStill(browser, base, still, file) {
  const ctx = await browser.newContext({
    viewport: still.viewport,
    deviceScaleFactor: still.scale,
    locale: 'en-US',
    colorScheme: 'light',
  });
  try {
    const page = await ctx.newPage();
    await page.goto(`${base}?lang=en`, { waitUntil: 'load' });
    await page.locator('button.card', { hasText: 'Weather' }).first().click();
    await page.locator('.tile').waitFor();
    await page.waitForTimeout(1500);
    await page.locator('aside.left div.row', { hasText: 'Temperature outside' }).first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: file });
  } finally {
    await ctx.close();
  }
}

export async function recordMaker(browser, base, dir) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US', colorScheme: 'light' });
  const frames = [];
  try {
    await ctx.addInitScript({ content: CURSOR });
    const page = await ctx.newPage();
    await page.goto(`${base}?lang=en`, { waitUntil: 'load' });
    await page.locator('button.card', { hasText: 'Next events' }).click();
    await page.locator('.tile').waitFor();
    await page.waitForTimeout(1500);
    const cdp = await ctx.newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
      const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ file, at: metadata.timestamp });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
    await play(page);
    await cdp.send('Page.stopScreencast');
    return frames;
  } finally {
    await ctx.close();
  }
}
