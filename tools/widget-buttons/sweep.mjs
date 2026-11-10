// Presses every button of the given tiles on the light layer page and says which do
// nothing. Writes never reach the server: they are answered here and counted. Run it
// against a side copy only, it removes the widgets placed there:
//   node tools/widget-buttons/sweep.mjs <port> media timer lighting
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
const [port, ...TILES] = process.argv.slice(2);
if (!/^\d+$/.test(port || '') || port === '3030' || !TILES.length) {
  console.error('usage: sweep.mjs <side copy port, never 3030> <tile> [tile...]');
  process.exit(2);
}
const BASE = `http://127.0.0.1:${port}`;
const act = async (a) => (await fetch(BASE + '/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(a) })).json();
await fetch(BASE + '/layers/host', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ layers: true, scene: true, menu: true, anchor: true, monitors: [{ key: 'MAIN', primary: true, name: 'Main', width: 3840, height: 2160 }] }) });

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const tile of TILES) {
    const list = (await act({ type: 'layerList' })).placed || [];
    for (const w of list) await act({ type: 'layerRemove', target: w.id });
    const placed = await act({ type: 'layerPlace', widget: tile, surface: 'overlay', position: 'center', size: 'large' });
    if (!placed.ok) { console.log(tile, 'NOT PLACED', JSON.stringify(placed).slice(0, 90)); continue; }
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    try {
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message.slice(0, 90)));
      let writes = [];
      // A button that opens a link answers with a new tab, not with the page changing.
      ctx.on('page', (tab) => { writes.push('opens a tab'); tab.close().catch(() => {}); });
      await page.route('**/*', (route) => {
        const r = route.request();
        const u = new URL(r.url());
        const read = r.method() === 'GET' && !/^\/(media|volume|audio|mic|power|system\/(?!stats))/.test(u.pathname);
        if (read) return route.continue();
        writes.push(r.method() + ' ' + u.pathname);
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await page.goto(BASE + '/?layer=overlay:', { waitUntil: 'load' });
      await page.waitForTimeout(3000);
      const count = await page.locator('.layer-slot button:visible').count();
      const dead = [];
      let live = 0;
      for (let i = 0; i < Math.min(count, 24); i++) {
        const b = page.locator('.layer-slot button:visible').nth(i);
        if (!(await b.count()) || await b.isDisabled().catch(() => true)) continue;
        const name = await b.evaluate((n) => n.id || n.getAttribute('aria-label') || n.title || n.textContent.trim().slice(0, 24) || n.className).catch(() => '?');
        await page.evaluate(() => {
          window.__m = 0;
          window.__o = new MutationObserver((l) => { window.__m += l.length; });
          window.__o.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        });
        writes = [];
        await b.click({ timeout: 1500, force: true }).catch(() => {});
        await page.waitForTimeout(350);
        const changed = await page.evaluate(() => { window.__o.disconnect(); return window.__m; }).catch(() => 1);
        if (writes.length || changed) live++;
        else dead.push(name);
        await page.keyboard.press('Escape').catch(() => {});
      }
      console.log(tile, 'buttons', count, 'answered', live, dead.length ? 'SILENT: ' + dead.join(' | ') : '', errors.length ? 'ERRORS: ' + [...new Set(errors)].join(' | ') : '');
    } finally { await ctx.close(); }
  }
} finally { await browser.close(); }
