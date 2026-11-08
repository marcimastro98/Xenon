// The new look's moving picture: one dashboard of the demo, the old look melting into Liquid
// Glass and back, so a person who updated sees on the sheet what the key next to it does.
import { withScene } from '../site-shots/shoot.mjs';
import { CLIP } from './widgets.mjs';

// The clip's own shape, so the dashboard is whole: a crop of a wide one would lose the island.
const SCENE = { viewport: { width: 1280, height: 1226, scale: 1.5 }, fixtures: ['weather', 'calendar'] };
// A whole dashboard at the other clips' 960 read soft on a 2560 px screen. Same shape, more pixels.
const LOOK_CLIP = { ...CLIP, width: 1440, height: 1380 };
const HIDE_DEMO = '#demo-badge,#demo-convert,.demo-na,.xtoast-stack{display:none!important}';
const SETTLE_MS = 800;
const MELT_AT = 1.6;
const MELT = 1.2;
const BACK_AT = 6.2;
const BACK = 0.8;

export function shootLooks(browser, base, before, after) {
  return withScene(browser, base, SCENE, async (page) => {
    await page.addStyleTag({ content: HIDE_DEMO });
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: after });
    await page.evaluate(() => applyThemeById('glass'));
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: before });
  });
}

export function lookArgs(before, after, out, clip = LOOK_CLIP) {
  const fit = `scale=${clip.width}:${clip.height}:flags=lanczos,setsar=1`;
  const fades = `fade=t=in:st=${MELT_AT}:d=${MELT}:alpha=1,fade=t=out:st=${BACK_AT}:d=${BACK}:alpha=1`;
  const filter = `[0:v]${fit},format=yuv420p[old];[1:v]${fit},format=rgba,${fades}[new];[old][new]overlay=format=auto[v]`;
  const still = (file) => ['-loop', '1', '-framerate', String(clip.fps), '-t', String(clip.seconds), '-i', file];
  return ['-y', '-v', 'error', ...still(before), ...still(after), '-filter_complex', filter, '-map', '[v]',
    '-t', String(clip.seconds), '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', out];
}
