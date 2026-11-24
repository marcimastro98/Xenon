// Pictures of every pump face (server/pump-face.html) at the pump sizes and in
// several languages, with invented data (fixture.mjs) through server.mjs. Each
// picture is checked: no page error, no text outside the round screen (or the
// square one), no text cut where it was not meant to end in "...", no empty ring
// drawing the round dots of its ends. The menu's preview of a pump never says hello.
// Playwright is borrowed as in tools/toast-gallery (../xenon-maker or XENON_PLAYWRIGHT).
// Run: node tools/pump-face-shots/shoot.mjs [outDir]   (default <temp>/xenon-pump-shots)
//   PUMP_LANGS=it,de  PUMP_SIZES=round480,wide  PUMP_ONLY=music  narrow the sweep.
// Exit 1 when a check fails.

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { CALL, HOT_SYSTEM, MAC_SYSTEM, MEDIA, MEDIA_LONG, MEDIA_NO_COVER, MEDIA_TAB_SOUND, NOTIFICATION, NOTIFICATION_ICON, SYSTEM } from './fixture.mjs';
import { startPumpFaceServer } from './server.mjs';

export const SIZES = [
  { name: 'round480', shape: 'round', width: 480, height: 480 },
  { name: 'round640', shape: 'round', width: 640, height: 640 },
  { name: 'square240', shape: 'square', width: 240, height: 240 },
  { name: 'wide', shape: 'wide', width: 320, height: 240 },
  // A panel standing up: its own, or a wide one mounted turned (the face page swaps its sides).
  { name: 'tall', shape: 'wide', width: 240, height: 320 },
];
const pick = (env, all, key) => (process.env[env] ? all.filter((x) => process.env[env].split(',').includes(key(x))) : all);

const face = (show, extra = {}) => ({ show, ...extra });
export const SHOTS = {
  'sensors-rings-1': face({ face: 'sensors', style: 'rings', readings: ['gpuTemp'] }),
  'sensors-rings-2': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'] }),
  'sensors-rings-3': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp', 'fps'] }),
  'sensors-rings-4': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp', 'cpu', 'gpu'] }),
  // Long values: a clock in GHz and a percentage at 100 must stay inside their cells.
  'sensors-rings-long': face({ face: 'sensors', style: 'rings', readings: ['cpuClock', 'gpu'] }, { system: { ...SYSTEM, gpu: 100 } }),
  'sensors-rings-long-4': face({ face: 'sensors', style: 'rings', readings: ['cpuClock', 'gpu', 'power', 'gpuClock'] }, { system: { ...SYSTEM, gpu: 100 } }),
  'sensors-hot': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'] }, { system: HOT_SYSTEM }),
  'sensors-no-reading': face({ face: 'sensors', style: 'rings', readings: ['gpuTemp', 'cpuTemp'] }, { system: MAC_SYSTEM }),
  'sensors-bars': face({ face: 'sensors', style: 'bars', readings: ['cpuTemp', 'gpuTemp', 'ram', 'power'] }),
  'sensors-numbers': face({ face: 'sensors', style: 'numbers', readings: ['cpuTemp', 'gpuTemp', 'cpuClock', 'vram'] }),
  game: face({ face: 'game', readings: ['fps', 'gpuTemp', 'cpuTemp'], track: true }),
  'game-no-fps': face({ face: 'game', readings: ['fps', 'gpuTemp', 'cpuTemp'], track: false }, { system: MAC_SYSTEM }),
  'music-cover': face({ face: 'music', style: 'cover' }),
  'music-vinyl': face({ face: 'music', style: 'vinyl' }),
  'music-pulse': face({ face: 'music', style: 'pulse' }),
  'music-long': face({ face: 'music', style: 'cover' }, { media: MEDIA_LONG }),
  'music-nothing': face({ face: 'music', style: 'cover' }, { media: {} }),
  'music-no-cover': face({ face: 'music', style: 'cover' }, { media: MEDIA_NO_COVER }),
  'music-vinyl-no-cover': face({ face: 'music', style: 'vinyl' }, { media: MEDIA_NO_COVER }),
  'music-pulse-nothing': face({ face: 'music', style: 'pulse', colors: 'fire' }, { media: {} }),
  'music-tab-sound': face({ face: 'music', style: 'cover' }, { media: MEDIA_TAB_SOUND }),
  'clock-digital': face({ face: 'clock', style: 'digital', seconds: false, date: true, weather: true }),
  'clock-seconds': face({ face: 'clock', style: 'digital', seconds: true, date: true, weather: false }),
  'clock-analog': face({ face: 'clock', style: 'analog', seconds: true, date: true, weather: true }),
  'picture-aurora': face({ face: 'picture', items: ['art:aurora'] }),
  'picture-ember': face({ face: 'picture', items: ['art:ember'] }),
  'picture-tide': face({ face: 'picture', items: ['art:tide'] }),
  'picture-orbit': face({ face: 'picture', items: ['art:orbit'] }),
  'picture-photo': face({ face: 'picture', items: ['/uploads/pump-photo.png'], fit: 'cover' }),
  // A line's look (face-look.js): colours, what is behind, big numbers, warm off, own text, units.
  'look-fire-big': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'], colors: 'fire', size: 'big', text: 'Studio PC' }),
  'look-ice-glow': face({ face: 'sensors', style: 'bars', readings: ['cpuTemp', 'gpuTemp', 'ram', 'power'], colors: 'ice', bg: 'glow' }),
  'look-own-picture': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp', 'fps'], colors: '#ff5fa2', bg: 'art:aurora', units: 'f' }),
  'look-hot-nowarn': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'], warn: false }, { system: HOT_SYSTEM }),
  'look-big-4': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp', 'cpu', 'gpu'], size: 'big', colors: 'violet' }),
  'look-game-mono': face({ face: 'game', readings: ['fps', 'gpuTemp', 'cpuTemp'], track: true, colors: 'mono', bg: 'art:ember', size: 'big' }),
  'look-clock-theme': face({ face: 'clock', style: 'analog', seconds: true, date: true, weather: true, colors: 'theme', units: 'f', text: 'Buongiorno' }),
  // Four colours of one's own: dark behind with a hot reading, then a light one (dark words).
  'look-own-four-hot': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'], colors: ['#ff2e88', '#ffd166', '#ff3b30', '#120a1f'] }, { system: HOT_SYSTEM }),
  'look-own-light-bars': face({ face: 'sensors', style: 'bars', readings: ['cpuTemp', 'gpuTemp', 'ram', 'power'], colors: ['#0a7cff', '#ff6b00', '#d7263d', '#f4efe6'] }, { system: HOT_SYSTEM }),
  'look-own-light-clock': face({ face: 'clock', style: 'analog', seconds: true, date: true, weather: true, colors: ['#0a7cff', '#ff6b00', '#d7263d', '#f4efe6'], text: 'Studio' }),
  'look-own-light-game': face({ face: 'game', readings: ['fps', 'gpuTemp', 'cpuTemp'], track: true, colors: ['#1b998b', '#2d3047', '#e84855', '#fffd82'] }),
  // What is behind the drop (Xenon's own style): it must show around it and through it.
  'bg-drop-glow': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'], bg: 'glow' }),
  'bg-drop-glow-hot': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'], bg: 'glow' }, { system: HOT_SYSTEM }),
  'bg-drop-photo': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp', 'cpu'], bg: '/uploads/pump-photo.png' }),
  'bg-drop-tide-clock': face({ face: 'clock', style: 'digital', seconds: false, date: true, weather: true, colors: 'ice', bg: 'art:tide' }),
  'bg-drop-orbit-music': face({ face: 'music', style: 'cover', bg: 'art:orbit' }),
  'bg-bars-aurora': face({ face: 'sensors', style: 'bars', readings: ['cpuTemp', 'gpuTemp', 'ram', 'power'], bg: 'art:aurora' }),
  'look-numbers-big': face({ face: 'sensors', style: 'numbers', readings: ['cpuTemp', 'gpuTemp', 'cpuClock', 'vram'], size: 'big', colors: 'picture', bg: 'art:tide' }),
  // Strumento (face-gauge.js): the screen's style draws these faces as a dial with a needle.
  'gauge-sensors': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'] }, { style: 'gauge' }),
  'gauge-sensors-f-big': face({ face: 'sensors', style: 'bars', readings: ['cpuTemp', 'fps'], units: 'f', size: 'big', text: 'Studio PC' }, { style: 'gauge' }),
  'gauge-hot': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'] }, { style: 'gauge', system: HOT_SYSTEM }),
  'gauge-hot-nowarn': face({ face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'], warn: false }, { style: 'gauge', system: HOT_SYSTEM }),
  'gauge-clocks': face({ face: 'sensors', style: 'rings', readings: ['gpuClock', 'power'] }, { style: 'gauge' }),
  'gauge-game': face({ face: 'game', readings: ['fps', 'gpuTemp', 'cpuTemp'], track: true, colors: 'fire' }, { style: 'gauge' }),
  'gauge-no-reading': face({ face: 'game', readings: ['fps', 'gpuTemp'], track: false }, { style: 'gauge', system: MAC_SYSTEM }),
  'gauge-music': face({ face: 'music', style: 'cover', colors: 'ice' }, { style: 'gauge' }),
  'gauge-music-long': face({ face: 'music', style: 'cover' }, { style: 'gauge', media: MEDIA_LONG }),
  'gauge-music-nothing': face({ face: 'music', style: 'cover' }, { style: 'gauge', media: {} }),
  'gauge-clock': face({ face: 'clock', style: 'digital', seconds: true, date: true, weather: true, text: 'Studio' }, { style: 'gauge' }),
  'gauge-own-light': face({ face: 'sensors', style: 'rings', readings: ['cpu', 'ram'], colors: ['#0a7cff', '#ff6b00', '#d7263d', '#f4efe6'] }, { style: 'gauge' }),
  'gauge-no-needle': face({ face: 'sensors', style: 'rings', readings: ['gpu', 'vram'], colors: 'violet' }, { style: 'gauge', gauge: { needle: false, arc: true } }),
  'gauge-no-arc': face({ face: 'game', readings: ['fps', 'cpuTemp'], colors: ['#ff2e88', '#ffd166', '#ff3b30', '#120a1f'] }, { style: 'gauge', gauge: { needle: true, arc: false } }),
  'gauge-picture-stays': face({ face: 'picture', items: ['art:tide'] }, { style: 'gauge' }),
  'alert-open': face({ face: 'clock' }, { textShown: true, push: ['windows_notification', NOTIFICATION] }),
  'alert-app-icon': face({ face: 'clock' }, { push: ['windows_notification', NOTIFICATION_ICON] }),
  'alert-hidden': face({ face: 'clock' }, { push: ['windows_notification', NOTIFICATION] }),
  'alert-call': face({ face: 'clock' }, { textShown: true, push: ['calls', CALL] }),
  'alert-timer': face({ face: 'clock' }, { push: ['timer_done', { id: 1, label: 'Tea' }] }),
  'alert-hot': face({ face: 'clock' }, { push: ['guardian_alert', { type: 'cpuTemp', value: 94 }] }),
};

// In the page: every element holding text, whether it leaves the screen's shape
// or is cut without an ellipsis.
function checkPage(shape) {
  const w = innerWidth;
  const h = innerHeight;
  const r = Math.min(w, h) / 2;
  const problems = [];
  // Runs in the page (page.evaluate sends this function's source only), so its helpers live here.
  // Words on the drop (Xenon's own style) keep inside its round middle, its half width less 4%
  // of the short side, so its edge never cuts them while it changes shape.
  function roomInside() {
    const problems = [];
    const u = Math.min(innerWidth, innerHeight) / 100;
    for (const drop of document.querySelectorAll('#pf-root .pf-drop:not(.pf-drop-music)')) {
      const layer = drop.parentElement;
      if (layer.closest('.pf-face-out, .pf-alert-out')) continue;
      const box = drop.getBoundingClientRect();
      const room = box.width / 2 - 4 * u;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      for (const el of layer.querySelectorAll(':is(.pf-drop-mid, .pf-clock-mid) *')) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const r = el.getBoundingClientRect();
        if (!own || !r.width) continue;
        const far = Math.max(...[[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
        if (far > room) problems.push(`too near the drop's edge: "${el.textContent.trim().slice(0, 30)}" (${Math.round(far)}px of ${Math.round(room)})`);
      }
    }
    return problems;
  }

  // What arrives over the face, and the words on the drop, sit on the screen's centre line.
  function centred() {
    const problems = [];
    const mid = innerWidth / 2;
    for (const el of document.querySelectorAll('.pf-alert:not(.pf-alert-out) .pf-alert-text > *, .pf-alert:not(.pf-alert-out) .pf-alert-icon, .pf-drop-mid, .pf-clock-mid')) {
      const r = el.getBoundingClientRect();
      if (r.width && Math.abs(r.left + r.width / 2 - mid) > 1.5) problems.push(`off centre: "${el.textContent.trim().slice(0, 30)}"`);
    }
    return problems;
  }

  // What is behind the drop shows: a glow around it (a glow in the middle sits all under it), a
  // picture bright, through the drop turned to glass, with no second drop in the way.
  function behindShows() {
    const problems = [];
    for (const layer of document.querySelectorAll('#pf-root .pf-face[data-drop]:not(.pf-face-out)')) {
      const drop = layer.querySelector('.pf-drop');
      if (layer.classList.contains('pf-bg-glow') && !/radial-gradient/.test(getComputedStyle(drop, '::before').backgroundImage)) problems.push('the glow sits all under the drop');
      if (!layer.classList.contains('pf-has-bg')) continue;
      const front = getComputedStyle(drop.querySelector('.pf-drop-front')).backgroundColor;
      if (!/\/\s*0?\.\d+\)$|,\s*0?\.\d+\)$/.test(front)) problems.push('the picture is hidden under a solid drop');
      if (getComputedStyle(drop.querySelector('.pf-drop-back')).display !== 'none') problems.push('the deeper drop hides the picture');
      const bright = Number((getComputedStyle(layer.querySelector('.pf-bg-pic')).filter.match(/brightness\(([\d.]+)\)/) || [])[1]);
      if (!(bright >= 0.8)) problems.push(`the picture behind the drop is dimmed to ${bright}`);
    }
    return problems;
  }

  for (const el of document.querySelectorAll('#pf-root *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own || el.closest('.pf-face-out, .pf-alert-out')) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(el).visibility === 'hidden') continue;
    const corners = [[box.left, box.top], [box.right, box.top], [box.left, box.bottom], [box.right, box.bottom]];
    const out = shape === 'round'
      ? corners.some(([x, y]) => Math.hypot(x - w / 2, y - h / 2) > r + 2)
      : corners.some(([x, y]) => x < -1 || y < -1 || x > w + 1 || y > h + 1);
    const cs = getComputedStyle(el);
    // An SVG text has no box of its own to be cut in (clientWidth is always 0): only its place counts.
    const cut = !(el instanceof SVGElement) && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.webkitLineClamp === 'none';
    if (out) problems.push(`outside the screen: "${el.textContent.trim().slice(0, 40)}"`);
    if (cut) problems.push(`cut: "${el.textContent.trim().slice(0, 40)}"`);
  }
  problems.push(...roomInside(), ...centred(), ...behindShows());
  for (const fill of document.querySelectorAll('.pf-fill')) {
    const empty = Number.parseFloat(fill.getAttribute('stroke-dasharray')) === 0;
    if (empty && getComputedStyle(fill).visibility !== 'hidden') problems.push('an empty ring draws the dots of its ends');
  }
  return problems;
}

async function post(base, p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function shootOne(page, base, size, name, shot, outDir, lang) {
  const errors = [];
  const onError = (e) => errors.push(String(e?.message ? e.message : e));
  page.on('pageerror', onError);
  try {
    await post(base, '/__push', { event: 'system', data: shot.system || SYSTEM });
    await post(base, '/__push', { event: 'media', data: shot.media || MEDIA });
    const look = { style: shot.style || 'xenon', gauge: shot.gauge || { needle: true, arc: true } };
    await post(base, '/pump', { screen: 'pump', patch: { alerts: { hideText: !shot.textShown }, ...look } });
    await page.goto(`${base}/pump-face?screen=pump&shape=${size.shape}&via=icue`);
    await page.waitForFunction(() => window.PumpFace && window.PumpFace.snapshot().screen === 'pump');
    await post(base, '/pump', { screen: 'pump', show: shot.show, minutes: 0 });
    await page.waitForFunction((f) => window.PumpFace.snapshot().face?.face === f, shot.show.face);
    if (shot.push) await post(base, '/__push', { event: shot.push[0], data: shot.push[1] });
    await page.waitForTimeout(shot.push ? 500 : 350);
    errors.push(...(await page.evaluate(checkPage, size.shape)));
    await page.screenshot({ path: path.join(outDir, `${lang}-${size.name}-${name}.png`) });
    if (shot.push && shot.push[0] === 'calls') await post(base, '/__push', { event: 'calls', data: { calls: [] } });
  } finally {
    page.off('pageerror', onError);
  }
  return errors;
}

// The menu's picture of a pump (?preview=1, js/menu/xenon-menu-pumps.js) mirrors the
// screen and never says hello, also for a name no pump has; a page with no ?shape= (the
// address NZXT CAM is given) still runs.
async function checkPreview(page, server) {
  const before = server.hellos;
  const errors = [];
  const onError = (e) => errors.push(String(e?.message ? e.message : e));
  page.on('pageerror', onError);
  // Music, never the clock: the clock is what a page that knows nothing shows.
  await post(server.url, '/pump', { screen: 'pump', show: { face: 'music', style: 'vinyl' }, minutes: 0 });
  await page.goto(`${server.url}/pump-face?screen=pump&shape=round&preview=1`);
  await page.waitForFunction(() => window.PumpFace && window.PumpFace.snapshot().face?.face === 'music', null, { timeout: 5000 })
    .catch(() => null);
  const problems = (await page.evaluate(() => window.PumpFace.snapshot().face?.face)) === 'music' ? [] : ['the preview does not mirror the screen'];
  await page.goto(`${server.url}/pump-face?screen=nobody&preview=1`);
  // A hello would follow the page's first read of the settings: give it two seconds.
  for (let waited = 0; waited < 2000 && server.hellos === before; waited += 100) await page.waitForTimeout(100);
  if (server.hellos !== before) problems.push('a preview said hello');
  page.off('pageerror', onError);
  return [...problems, ...errors];
}

async function main() {
  const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'xenon-pump-shots'));
  await mkdir(outDir, { recursive: true });
  const langs = (process.env.PUMP_LANGS || 'en').split(',');
  const sizes = pick('PUMP_SIZES', SIZES, (s) => s.name);
  const names = Object.keys(SHOTS).filter((n) => !process.env.PUMP_ONLY || process.env.PUMP_ONLY.split(',').some((o) => n.startsWith(o)));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  let failed = 0;
  try {
    for (const lang of langs) {
      const server = await startPumpFaceServer({ lang });
      const context = await browser.newContext({ reducedMotion: 'reduce' });
      try {
        await post(server.url, '/pump', { screen: 'pump', setup: 'game' });
        const page = await context.newPage();
        for (const size of sizes) {
          await page.setViewportSize({ width: size.width, height: size.height });
          for (const name of names) {
            const problems = await shootOne(page, server.url, size, name, SHOTS[name], outDir, lang);
            if (problems.length) { failed += 1; console.log(`FAIL ${lang} ${size.name} ${name}: ${problems.join('; ')}`); }
          }
        }
        if (lang === langs[0]) {
          const problems = await checkPreview(page, server);
          if (problems.length) { failed += 1; console.log(`FAIL preview: ${problems.join('; ')}`); }
        }
      } finally {
        await context.close();
        await server.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`${failed ? failed + ' failed' : 'all clean'}, pictures in ${outDir}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
