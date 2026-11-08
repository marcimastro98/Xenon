// Every hub mail and public page as it renders, from the real templates of the hub repo.
// Nothing is sent and nothing leaves the machine: the page only gets the site's fonts, Bit and
// one catalog picture from local files. Also writes a contact sheet per look, to read them fast.
// Run: node tools/mail-shots/shoot.mjs --out <dir> [kind ...] [--no-fonts]
// --no-fonts draws what Gmail and Outlook draw: they drop the web font.
// The hub is a checkout beside this repo, or XENON_HUB.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HUB = process.env.XENON_HUB || path.resolve(ROOT, '..', 'xenon-supporter-hub');
const HUB_URL = 'https://hub.test';
const PICTURE = path.join(ROOT, 'docs', 'images', 'home', 'desktop-widgets.webp');

export const LOOKS = [
  { scheme: 'light', width: 640 },
  { scheme: 'dark', width: 640 },
  { scheme: 'light', width: 375 },
];

const argOf = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? '' : process.argv[at + 1];
};

const env = { PUBLIC_BASE_URL: HUB_URL, BMC_URL: 'https://buymeacoffee.com/sample', CATALOG_SITE_BASE: 'https://xenon-app.com/community/' };
const LONG_NAME = 'Haunted House and the Very Long Name of a Pack';

// The mails that only show their problems with real content, beside the plain previews.
async function extraMails(hubSrc) {
  const { emailPreview } = await import(hubSrc + 'email.js');
  const { buildTrialCodeEmail, buildTrialReminderEmail } = await import(hubSrc + 'trial-mail.js');
  const entry = (id, name) => ({ id, name, description: 'A theme, a background and two widgets that belong together.' });
  const drop = (entries, audience) => {
    const shots = Object.fromEntries(entries.map((e) => [e.id, `${HUB_URL}/picture.webp`]));
    return emailPreview(env, 'drop', { entries, shots, audience });
  };
  const mail = ([subject, html]) => ({ subject, html });
  return {
    drop_one: drop([entry('one', 'Haunted House')], 'active'),
    drop_two: drop([entry('one', 'Haunted House'), entry('two', LONG_NAME)], 'lapsed'),
    trial_code_ja: mail(buildTrialCodeEmail('XT-SAMPLE-CODE', `${HUB_URL}/email/unsubscribe?t=sample`, 'ja')),
    trial_reminder_fr: mail(buildTrialReminderEmail(env, 2, 'fr')),
  };
}

// The trial page's reads: `row` answers the one that says the trial is open.
function fakeDb(row) {
  const statement = { bind: () => statement, run: async () => ({ success: true, meta: {} }), first: async () => row, all: async () => ({ results: [] }) };
  return { prepare: () => statement, batch: async () => [] };
}

async function publicPages(hubSrc) {
  const { hubPage } = await import(hubSrc + 'hub-page.js');
  const { handleTrialPage } = await import(hubSrc + 'trial.js');
  // setContent has no origin: Bit needs the hub's address written out.
  const html = async (response) => (await response.text()).replaceAll('src="/email/', `src="${HUB_URL}/email/`);
  const trialEnv = { ...env, DB: fakeDb({ value: 'false' }), TRIAL_PEPPER: 'sample', CLAIM_TURNSTILE_SITE_KEY: 'sample', CLAIM_TURNSTILE_SECRET: 'sample' };
  const trial = await html(await handleTrialPage(new Request(`${HUB_URL}/trial`, { headers: { 'accept-language': 'en' } }), trialEnv));
  // The page's three pictures come from the live catalog: the same list, with a local picture.
  const gets = `<ul class="gets">${['Deep Ocean', 'Lakeside', 'Aracne'].map((name) => `<li><img src="${HUB_URL}/picture.webp" alt="">${name}</li>`).join('')}</ul>`;
  return {
    page_trial: trial.replace('<form', `${gets}<form`),
    page_unsubscribe: await html(hubPage('Unsubscribe', '<h1>Stop emails about new drops?</h1><p>These are the emails that say a new supporter drop is in the Store. You keep your supporter code and everything you unlocked.</p><form><button>Unsubscribe</button></form><p><button class="quiet" type="button">Keep them</button></p>')),
    page_done: await html(hubPage('Unsubscribed', '<h1>You are unsubscribed</h1><p>No more emails about new drops.</p>')),
  };
}

async function shootAll(browser, items, outDir, fonts) {
  const shots = [];
  for (const look of LOOKS) {
    const context = await browser.newContext({ viewport: { width: look.width, height: 900 }, colorScheme: look.scheme, locale: 'en-US' });
    try {
      await context.route(/^https?:\/\//, (route) => {
        const url = route.request().url();
        if (url.includes('/email/bit-sheet')) return route.fulfill({ path: path.join(ROOT, 'docs/images/brand/bit-sheet-4x.png') });
        if (url.includes('/email/bit')) return route.fulfill({ path: path.join(ROOT, 'docs/images/brand/bit-4x.png') });
        if (url.includes('/picture.webp')) return route.fulfill({ path: PICTURE });
        if (fonts && url.includes('/fonts/')) return route.fulfill({ path: path.join(ROOT, 'docs/fonts', url.split('/fonts/')[1]) });
        return route.abort();
      });
      for (const [name, html] of items) {
        const page = await context.newPage();
        try {
          await page.setContent(html, { waitUntil: 'load' });
          await page.evaluate(() => document.fonts.ready);
          const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
          if (wide) console.log(`TOO WIDE ${name} at ${look.width}`);
          const file = path.join(outDir, `${name}-${look.scheme}-${look.width}.png`);
          await page.screenshot({ path: file, fullPage: true });
          shots.push({ ...look, name, file });
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
    }
  }
  return shots;
}

// Pictures read as files: a sheet of them at reading size, one per look.
async function contactSheets(browser, shots, outDir) {
  for (const look of LOOKS) {
    const own = shots.filter((s) => s.scheme === look.scheme && s.width === look.width);
    const cells = await Promise.all(own.map(async (s) => {
      const data = (await readFile(s.file)).toString('base64');
      return `<figure><figcaption>${s.name}</figcaption><img src="data:image/png;base64,${data}"></figure>`;
    }));
    const html = `<!doctype html><style>body{margin:0;padding:16px;background:#777;font:14px sans-serif;columns:4 ${look.width === 375 ? 260 : 380}px;column-gap:16px}figure{margin:0 0 16px;break-inside:avoid}figcaption{color:#fff;padding:0 0 4px}img{display:block;width:100%}</style>${cells.join('')}`;
    const context = await browser.newContext({ viewport: { width: look.width === 375 ? 1180 : 1640, height: 900 } });
    try {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.screenshot({ path: path.join(outDir, `_sheet-${look.scheme}-${look.width}.png`), fullPage: true });
    } finally {
      await context.close();
    }
  }
}

async function main() {
  const outDir = argOf('--out');
  if (!outDir) throw new Error('Say where the pictures go: --out <dir>');
  const fonts = !process.argv.includes('--no-fonts');
  const wanted = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--out');
  const hubSrc = pathToFileURL(path.join(HUB, 'src') + path.sep).href;
  const { emailPreview, EMAIL_KINDS } = await import(hubSrc + 'email.js');
  const mails = Object.fromEntries(EMAIL_KINDS.map((kind) => [kind, emailPreview(env, kind)]));
  Object.assign(mails, await extraMails(hubSrc));
  const pages = await publicPages(hubSrc);
  const all = [...Object.entries(mails).map(([name, mail]) => [name, mail.html]), ...Object.entries(pages)];
  const items = wanted.length ? all.filter(([name]) => wanted.includes(name)) : all;
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'subjects.txt'), Object.entries(mails).map(([name, mail]) => `${name}: ${mail.subject} (${Math.round(mail.html.length / 1024)} KB)`).join('\n') + '\n');
  const browser = await loadPlaywright().chromium.launch();
  try {
    const shots = await shootAll(browser, items, outDir, fonts);
    await contactSheets(browser, shots, outDir);
    console.log(`${shots.length} pictures in ${outDir}`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
