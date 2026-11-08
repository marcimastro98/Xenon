// Sweeps the sound mixer of the Liquid look through the sizes a person can give it: the System
// tile's Volume and Microphone tabs and the Audio and Microphone widgets taken out of it, on the
// built demo with invented data, with a few apps and with many, on a desktop grid and on a phone.
// Measures what one picture cannot show: words over each other, a fader or a key out of reach, a
// fader too thin for a finger or not under it, the mixer scrolling sideways, the old round
// button or the dot on the track. Exits 1 when something is wrong.
// Run: node tools/mixer-check/check.mjs [--sizes 700x340,380x200] [--only volume|mic|audio|micw]
//   [--out dir]   (--out saves a picture of the tile at every size with a problem)
// Needs docs/demo: node tools/build-demo.mjs

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startSite } from '../site-shots/serve.mjs';
import { initScript } from '../site-shots/scenes.mjs';
import { soloLayout } from '../site-shots/widgets.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const WIDTHS = [340, 420, 480, 560, 700, 900, 1150];
const HEIGHTS = [190, 240, 300, 360, 440, 560, 680];
const PHONE_HEIGHTS = [180, 260, 340, 520];
const SETTLE_MS = 4500;
const PAINT_MS = 150;

const SUBJECTS = {
  volume: { tile: 'system', tab: 'volume', root: '#sys-grid-audio' },
  mic: { tile: 'system', tab: 'mic', root: '#sys-grid-mic' },
  audio: { tile: 'audio', root: '[data-dashboard-widget="audio"].dashboard-widget' },
  micw: { tile: 'mic', root: '[data-dashboard-widget="mic"].dashboard-widget' },
};

const app = (i, name, volume) => ({ id: `x${i}`, proc: `${name}.exe`, name, volume, muted: i % 4 === 3 });
const NAMES = ['Spotify', 'Discord', 'Chrome', 'OBS Studio', 'Steam', 'Microsoft Teams', 'VLC media player', 'Firefox'];
const STATES = {
  few: { speaker: NAMES.slice(0, 3).map((n, i) => app(i, n, 90 - i * 20)), mic: NAMES.slice(1, 3).map((n, i) => app(i, n, 80)) },
  many: { speaker: NAMES.map((n, i) => app(i, n, 100 - i * 11)), mic: NAMES.slice(1, 6).map((n, i) => app(i, n, 70)) },
};

function argOf(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? '' : process.argv[at + 1];
}

const OUT = argOf('--out') ? path.resolve(argOf('--out')) : '';
if (OUT) mkdirSync(OUT, { recursive: true });

function sizes() {
  const given = argOf('--sizes');
  if (given) return given.split(',').map((s) => s.split('x').map(Number));
  return WIDTHS.flatMap((w) => HEIGHTS.map((h) => [w, h]));
}

// Runs in the page: the apps every later poll of the demo also sends, drawn now.
function useApps({ speaker, mic }) {
  window.__XD__.audio.speakerApps = speaker;
  window.__XD__.audio.micApps = mic;
  window.renderSpeakerApps(speaker);
  window.renderMicApps(mic);
}

// Runs in the page. Returns what is wrong with the mixer at the size its tile has now.
function measure(rootSel) {
  const root = document.querySelector(rootSel);
  if (!root || !root.getClientRects().length) return ['not on screen'];
  const tile = root.closest('.dashboard-widget') || root;
  const box = tile.getBoundingClientRect();
  const problems = [];
  const name = (el) => String(el.className || el.tagName).split(' ')[0];
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const all = (sel) => [...root.querySelectorAll(sel)].filter(shown);
  const meet = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const scrolls = (el) => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight;
  // Below the tile's edge is fine when a box between it and the tile scrolls down to it.
  const reachable = (el) => {
    const r = el.getBoundingClientRect();
    if (r.left < box.left - 1 || r.right > box.right + 1) return false;
    if (r.top >= box.top - 1 && r.bottom <= box.bottom + 1) return true;
    for (let up = el.parentElement; up; up = up.parentElement) {
      if (scrolls(up)) return true;
      if (up === tile) break;
    }
    return false;
  };
  // The part of a box that shows: a scrolling list or the tile cuts off the rest.
  const seen = (el) => {
    let { left, top, right, bottom } = el.getBoundingClientRect();
    for (let up = el.parentElement; up; up = up.parentElement) {
      if (getComputedStyle(up).overflowY !== 'visible') {
        const r = up.getBoundingClientRect();
        left = Math.max(left, r.left); top = Math.max(top, r.top);
        right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
      }
      if (up === tile) break;
    }
    return { left, top, right, bottom, empty: right - left < 1 || bottom - top < 1 };
  };
  const whole = (el) => {
    const r = el.getBoundingClientRect();
    const s = seen(el);
    return !s.empty && s.top <= r.top + 0.5 && s.bottom >= r.bottom - 0.5 && s.left <= r.left + 0.5 && s.right >= r.right - 0.5;
  };

  for (const el of [tile, ...all('.volume-wrap, .mic-mixer, .speaker-apps, .mic-apps')]) {
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') problems.push(`${name(el)} scrolls sideways`);
  }
  const words = all('.vol-title, .vol-value, .app-mix-name, .app-mix-vol, .mic-vol-label, .mic-vol-value, .status-label, .mic-context, .device-label, .device-name')
    .map((el) => ({ el, at: seen(el) })).filter((w) => !w.at.empty);
  for (let i = 0; i < words.length; i += 1) {
    for (let j = i + 1; j < words.length; j += 1) {
      if (meet(words[i].at, words[j].at)) problems.push(`${name(words[i].el)} over ${name(words[j].el)}`);
    }
  }
  for (const el of all('.mix-fader > input, .mic-vol-track, .vol-mute-btn, .app-mix-mute, .mic-btn, .device-row')) {
    if (!reachable(el)) problems.push(`${name(el)} out of reach`);
  }
  for (const input of all('.mix-fader > input')) {
    const r = input.getBoundingClientRect();
    if (Math.min(r.width, r.height) < 40) problems.push(`fader ${Math.round(r.width)}x${Math.round(r.height)} too thin`);
    if (whole(input) && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== input) problems.push('a fader not under the finger');
  }
  for (const track of all('.mic-vol-track')) {
    const t = track.getBoundingClientRect();
    const s = track.querySelector('.mic-vol-slider').getBoundingClientRect();
    if (Math.abs(t.width - s.width) > 4 || Math.abs(t.height - s.height) > 4) problems.push('the input range does not cover its fader');
    if (getComputedStyle(track, '::after').display !== 'none') problems.push('a dot on the input fader');
  }
  if (all('.ring, .ring2, .glow').length) problems.push('the old round button');
  for (const key of all('.mic-btn')) {
    const r = key.getBoundingClientRect();
    if (r.height < 44 || r.width < 44) problems.push('the mic key under a finger\'s size');
  }
  return problems;
}

async function sweep(browser, base, subjectName, subject, list, viewport) {
  const ctx = await browser.newContext({ viewport, locale: 'en-US', timezoneId: 'Europe/Rome' });
  const found = [];
  try {
    const origin = new URL(base).origin;
    await ctx.route('**/*', (r) => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
    await ctx.addInitScript({ content: initScript({ layout: soloLayout(subject.tile, null, [8, 5]) }) });
    const page = await ctx.newPage();
    await page.goto(`${base}demo/`, { waitUntil: 'load' });
    await page.addStyleTag({ content: '.demo-na,.xtoast-stack{display:none!important}' });
    await page.waitForTimeout(SETTLE_MS);
    if (subject.tab) await page.evaluate((tab) => window.setSystemTab(tab), subject.tab);
    const sel = `.grid-stack-item:has([data-dashboard-widget="${subject.tile}"].dashboard-widget)`;
    for (const [state, apps] of Object.entries(STATES)) {
      await page.evaluate(useApps, apps);
      for (const [w, h] of list) {
        await page.evaluate(({ s, width, height }) => {
          const item = document.querySelector(s);
          if (width) item.style.setProperty('width', `${width}px`, 'important');
          item.style.setProperty('height', `${height}px`, 'important');
        }, { s: sel, width: w, height: h });
        await page.waitForTimeout(PAINT_MS);
        const problems = await page.evaluate(measure, subject.root);
        const where = w ? `${w}x${h}` : `phone ${h}`;
        if (!problems.length) continue;
        found.push(`${subjectName} ${state} ${where}: ${[...new Set(problems)].join(', ')}`);
        if (OUT) await page.locator(sel).screenshot({ path: path.join(OUT, `${subjectName}-${state}-${where.replace(' ', '-')}.png`) });
      }
    }
  } finally {
    await ctx.close();
  }
  return found;
}

const site = await startSite(0);
const browser = await loadPlaywright().chromium.launch();
const problems = [];
let checked = 0;
try {
  const base = `http://127.0.0.1:${site.port}/`;
  const only = argOf('--only');
  const desk = sizes();
  const phone = PHONE_HEIGHTS.map((h) => [0, h]);
  for (const [name, subject] of Object.entries(SUBJECTS)) {
    if (only && only !== name) continue;
    problems.push(...await sweep(browser, base, name, subject, desk, { width: 1920, height: 1080 }));
    problems.push(...await sweep(browser, base, name, subject, phone, { width: 390, height: 844 }));
    checked += (desk.length + phone.length) * Object.keys(STATES).length;
  }
} finally {
  await browser.close();
  await site.stop();
}
problems.forEach((p) => console.log(p));
console.log(`${checked} sizes checked, ${problems.length} with a problem`);
process.exitCode = problems.length ? 1 : 0;
