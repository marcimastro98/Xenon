// The site's forms in every state: /get/, /submit/status/ and /submit/, one theme, one width, one
// language. The hub and Turnstile are stubbed and every other outside request is blocked, so a
// real submission can never leave this PC. It prints overflow and page errors as it goes.
// Run: node tools/site-review/forms.mjs [--out dir] [--theme light|dark] [--width n] [--lang en]

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_DIR, startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const PHONE_BELOW = 700;
const CORS = { 'access-control-allow-origin': '*' };

const HASH = '#sub_abc123.' + 'a'.repeat(43);
const report = (outcome, extra = {}) => ({
  source: 'review', outcome,
  summary: 'A clean theme with a strong idea. Two things hold it back.',
  positives: ['The palette holds together on every tile', 'Readable at arm\'s length'],
  findings: [
    { what: 'The clock text sits on a bright band', severity: 'block', effort: 'quick', where: 'theme.json:42', why: 'White on pale yellow is hard to read.', fix: 'Darken the band or set the text to dark.', example: '"--clock-ink": "#102030"' },
    { what: 'The second screenshot shows a personal calendar', severity: 'fix', effort: 'medium', where: 'Screenshot 2, top half', why: 'Real names should not appear.', fix: 'Retake it with invented events.' },
    { what: 'A shorter name would fit the card', severity: 'tip', effort: 'quick', fix: 'Try under 20 characters.' },
    { what: 'One more for the list', severity: 'tip', effort: 'quick' },
    { what: 'And another', severity: 'tip', effort: 'quick' },
    { what: 'And the last', severity: 'tip', effort: 'quick' },
  ],
  scores: { security: 9, works: 8, efficiency: 6, design: 7, listing: 7 }, ...extra,
});
const SUB = { name: 'Northern Lights', kind: 'theme', version: '1.2.0', submittedAt: 1793000000, status: 'pending' };
export const STATES = {
  pending: { ...SUB, priority: true },
  fix: { ...SUB, status: 'pending', report: report('fix'), note: 'Nice start. Fix the two items and send it again.' },
  free: { ...SUB, report: report('free', { findings: [] }) },
  approved: { ...SUB, status: 'approved', entryId: 'northern-lights', report: report('free', { findings: [] }) },
  rejected: { ...SUB, status: 'rejected', note: 'This copies another entry in the catalog.' },
};
export const AUDIT = {
  ok: true, reportFilename: 'audit.md', report: '# Xenon submission audit',
  audit: {
    verdict: 'red',
    findings: [
      { id: 'a', severity: 'block', message: 'The widget asks for a host that is not declared', file: 'main.js', line: 12, why: 'Requests outside the manifest are blocked.', fix: 'Add the host to the manifest.', excerpt: "fetch('https://example.test/api')" },
      { id: 'b', severity: 'warn', message: 'A timer never stops', file: 'main.js', line: 40, why: 'It keeps running while the page is hidden.', fix: 'Clear it on teardown.' },
      { id: 'c', severity: 'info', message: 'No version in the manifest' },
    ],
  },
};

export function parseArgs(argv) {
  const o = { out: path.join(os.tmpdir(), 'xenon-site-forms'), theme: 'light', width: 1440, lang: 'en' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--theme') o.theme = argv[++i] === 'dark' ? 'dark' : 'light';
    else if (a === '--width') o.width = Number(argv[++i]);
    else if (a === '--lang') o.lang = argv[++i];
    else throw new Error(`unknown option ${a}`);
  }
  if (!(o.width >= 280 && o.width <= 3840)) throw new Error('--width takes 280 to 3840');
  return o;
}

// What the page may reach: the stubbed hub answers, everything else outside this PC is refused.
export function hubReply(url, statusReply) {
  if (url.endsWith('/submission/status')) {
    if (statusReply === 'offline') return { abort: true };
    if (statusReply === 404 || statusReply === 429) return { status: statusReply, body: '{}' };
    return { json: { ok: true, submission: statusReply }, headers: CORS };
  }
  if (url.endsWith('/audit')) return { json: AUDIT, headers: CORS };
  if (url.endsWith('/submit')) return { json: { ok: true, id: 'sub_abc123', statusToken: 'a'.repeat(43) }, headers: CORS };
  return { abort: true };
}

async function main() {
  const { out, theme, width, lang } = parseArgs(process.argv.slice(2));
  await mkdir(out, { recursive: true });
  const site = await startSite(0);
  const base = `http://127.0.0.1:${site.port}`;
  const browser = await loadPlaywright().chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height: width < PHONE_BELOW ? 844 : 900 }, colorScheme: theme, locale: 'en-US' });
  let i = 0;
  try {
    await ctx.addInitScript((l) => {
      try { localStorage.setItem('xenon.site.consent', 'denied'); localStorage.setItem('xenon.site.lang', l); } catch { /* private mode */ }
      window.turnstile = { render(sel, o) { setTimeout(() => o.callback('tok'), 0); return 'w'; }, reset() {} };
    }, lang);
    let statusReply = null;
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => {
      const reply = hubReply(r.request().url(), statusReply);
      return reply.abort ? r.abort() : r.fulfill(reply);
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = async (name, full = true) => {
      const n = String(i++).padStart(2, '0') + '-' + name;
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      console.log(n, m.w > m.cw ? 'OVERFLOW' : 'ok');
      await page.screenshot({ path: path.join(out, n + '.jpg'), type: 'jpeg', quality: 74, fullPage: full });
    };

    await page.goto(base + '/get/', { waitUntil: 'load' }); await shot('get-empty');
    await page.goto(base + '/get/#code=eyJ4ZW5vblByZXNldCI6MSwia2luZCI6InRoZW1lIiwibmFtZSI6Ik5vcnRoZXJuIExpZ2h0cyJ9', { waitUntil: 'load' });
    await page.reload({ waitUntil: 'load' }); await shot('get-code');
    await page.click('#copy').catch((e) => console.log('copy', e.message)); await shot('get-copied', false);

    for (const [name, sub] of Object.entries(STATES)) {
      statusReply = sub;
      await page.goto('about:blank');
      await page.goto(base + '/submit/status/' + HASH, { waitUntil: 'load' });
      await shot('status-' + name);
    }
    for (const [name, reply] of [['badlink', 404], ['rate', 429], ['offline', 'offline']]) {
      statusReply = reply;
      await page.goto('about:blank');
      await page.goto(base + '/submit/status/' + HASH, { waitUntil: 'load' });
      await shot('status-' + name, false);
    }
    await page.goto(base + '/submit/status/', { waitUntil: 'load' }); await shot('status-nohash', false);

    await page.goto(base + '/submit/', { waitUntil: 'load' });
    await page.evaluate(() => window.onloadTurnstile && window.onloadTurnstile());
    await shot('submit-fresh');
    await page.check('#isUpdate'); await shot('submit-update', false);
    await page.uncheck('#isUpdate');
    await page.selectOption('#kind', 'theme');
    await page.selectOption('#category', 'style');
    await page.fill('#name', 'Northern Lights');
    await page.fill('#author', 'Sam');
    await page.fill('#version', '1.0.0');
    await page.fill('#contact', 'sam@example.test');
    await page.fill('#tags', 'aurora dark');
    await page.fill('#description', 'A calm green theme for a spare screen.');
    await page.fill('#code', JSON.stringify({ xenonPreset: 1, kind: 'theme', name: 'Northern Lights', theme: { accent: '#6ee787', bg: '#0b1412', text: '#e9f6ee' } }));
    await page.waitForTimeout(1400);
    for (const n of [0, 1]) await page.locator('.shots input[type=file]').first().setInputFiles(path.join(DOCS_DIR, 'images/home/w-deck.webp'));
    await page.fill('#justification', 'It reads the aurora forecast.').catch(() => {});
    await shot('submit-audit');
    await page.click('#send');
    await page.waitForTimeout(500);
    await shot('submit-ok');
    console.log('focus on', await page.evaluate(() => document.activeElement?.id), 'err', await page.locator('#err').textContent().catch(() => ''));
    console.log('page errors:', errors.length ? errors.join(' | ') : 'none');
  } finally {
    await ctx.close();
    await browser.close();
    await site.stop();
  }
  console.log(`shots: ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
