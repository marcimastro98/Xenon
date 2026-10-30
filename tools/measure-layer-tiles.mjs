// Measures each built-in tile on the light layer page (server/layer-lite.html):
// the page is composed from the working tree for one tile (server/layer-page.js),
// opened in a headless Edge/Chrome, and checked for script errors, an empty
// tile, and the memory its renderer takes over an empty light page.
//
// Read-only against the server it points at: every request that is not a GET
// fails, and /settings is answered with layers that place only the tile under
// test. Use a test copy of the server for tiles that need data.
//
//   node tools/measure-layer-tiles.mjs [--server http://127.0.0.1:3031]
//     [--browser <path>] [--wait 8] [--html] [--shots <dir>] [--write server/test/fixtures/layer-tile-memory.json] [tile ...]
//
// No tile names: every tile js/layer-tiles.js marks as light. --write records
// the measured megabytes, which test/layer-tiles.test.mjs holds to the budget;
// --html prints the start of what each tile drew, --shots saves a picture of it.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const LayerTiles = require(path.join(ROOT, 'js', 'layer-tiles.js'));
const LayerPage = require(path.join(ROOT, 'layer-page.js'));
const SURFACE = 'overlay:probe';
const CDP_PORT = 9341;

// The layers that put one tile (or nothing) on the probe surface.
export function layersFor(tile) {
  const widgets = tile ? [{ id: 'lw_probe1', kind: 'tile', widget: tile, surface: 'overlay', monitor: 'probe', rect: { x: 0.05, y: 0.05, w: 0.4, h: 0.6 } }] : [];
  return { enabled: true, widgets };
}

// The page's renderer: the largest new one (each probe runs in a fresh context).
export function pageFootprint(rows, newPids) {
  const own = rows.filter((r) => newPids.includes(r.pid) && Number.isFinite(r.mb));
  return own.length ? Math.max(...own.map((r) => r.mb)) : null;
}

// What a tile drew: something besides its empty mount.
export function verdict(sample) {
  if (sample.errors.length) return 'errors';
  if (!sample.slots) return 'not placed';
  if (sample.text < 1 && sample.elements < 3) return 'empty';
  return 'ok';
}

function browserPath(flag) {
  if (flag) return flag;
  if (process.env.XENON_PROBE_BROWSER) return process.env.XENON_PROBE_BROWSER;
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  return existsSync(edge) ? edge : 'google-chrome';
}

function args(argv) {
  const out = { server: 'http://127.0.0.1:3031', wait: 8, write: '', browser: '', html: false, shots: '', tiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') out.server = argv[++i];
    else if (a === '--wait') out.wait = Number(argv[++i]) || 8;
    else if (a === '--write') out.write = argv[++i];
    else if (a === '--browser') out.browser = argv[++i];
    else if (a === '--html') out.html = true;
    else if (a === '--shots') out.shots = argv[++i];
    else out.tiles.push(a);
  }
  if (!out.tiles.length) out.tiles = [...LayerTiles.LITE];
  return out;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function version() {
  try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch { return null; }
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    const v = await version();
    if (v) return v;
    await sleep(250);
  }
  throw new Error('the browser did not open its debugging port');
}

// Asks the browser on the probe port to quit, and waits until the port is free.
async function closeBrowser(c) {
  c.send('Browser.close');   // the browser may quit before it answers
  for (let i = 0; i < 20 && await version(); i++) await sleep(250);
  try { c.ws.close(); } catch { /* already closed with the browser */ }
}

// A probe stopped from outside leaves its browser holding the port, and the next
// run would measure inside it: close it first.
async function closeLeftover() {
  const v = await version();
  if (!v) return;
  const c = cdp(v.webSocketDebuggerUrl);
  await c.open;
  await closeBrowser(c);
  if (await version()) throw new Error('a browser still holds port ' + CDP_PORT);
}

// Edge on Windows hands off to a process tree that kill() does not reach.
function killTree(child) {
  if (process.platform !== 'win32') { child.kill(); return; }
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

// The ok tiles go into the fixture as they are measured, so a stopped run keeps them.
function record(file, emptyPageMB, s) {
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { tiles: {} };
  prev.emptyPageMB = emptyPageMB;
  if (s && s.verdict === 'ok' && s.deltaMB != null) prev.tiles[s.tile] = s.deltaMB;
  prev.tiles = Object.fromEntries(Object.entries(prev.tiles).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, JSON.stringify(prev, null, 2) + '\n');
}

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiters = new Map();
  const handlers = new Set();
  ws.onmessage = (m) => {
    const r = JSON.parse(m.data);
    if (r.id && waiters.has(r.id)) { waiters.get(r.id)(r.result || r.error); waiters.delete(r.id); return; }
    for (const h of handlers) h(r);
  };
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const i = ++id; waiters.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  return { ws, send, on: (h) => handlers.add(h), off: (h) => handlers.delete(h), open: new Promise((r) => { ws.onopen = r; }) };
}

async function memoryRows(c) {
  const events = [];
  let done;
  const complete = new Promise((r) => { done = r; });
  const h = (r) => {
    if (r.method === 'Tracing.dataCollected') events.push(...r.params.value);
    if (r.method === 'Tracing.tracingComplete') done();
  };
  c.on(h);
  await c.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-memory-infra', '__metadata'], memoryDumpConfig: { triggers: [] } }, transferMode: 'ReportEvents' });
  await sleep(300);
  await c.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed' });
  await c.send('Tracing.end');
  await complete;
  c.off(h);
  return events.filter((e) => e.ph === 'v' && e.args && e.args.dumps && e.args.dumps.process_totals)
    .map((e) => ({ pid: e.pid, mb: Math.round(parseInt(e.args.dumps.process_totals.private_footprint_bytes || '0', 16) / 1048576) }));
}

async function sample(c, opt, tile, files) {
  const doc = LayerPage.compose(files.lite, tile ? [tile] : [], files.dashboard);
  const settingsLayers = layersFor(tile);
  const errors = [];
  const blocked = [];
  const pidsBefore = new Set(((await c.send('SystemInfo.getProcessInfo')).processInfo || []).map((p) => p.id));
  const { browserContextId } = await c.send('Target.createBrowserContext');
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', browserContextId, width: 1920, height: 1080 });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  const h = async (r) => {
    if (r.sessionId !== sessionId) return;
    if (r.method === 'Runtime.exceptionThrown') errors.push(String(r.params.exceptionDetails.exception?.description || r.params.exceptionDetails.text).split('\n')[0].slice(0, 200));
    if (r.method === 'Runtime.consoleAPICalled' && r.params.type === 'error') {
      errors.push(r.params.args.map((a) => a.value ?? a.description ?? '').join(' ').split('\n')[0].slice(0, 200));
    }
    if (r.method !== 'Fetch.requestPaused') return;
    const p = r.params;
    const u = new URL(p.request.url);
    if (!['GET', 'HEAD'].includes(p.request.method)) {
      blocked.push(p.request.method + ' ' + u.pathname);
      c.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sessionId);
    } else if (p.resourceType === 'Document' && u.pathname === '/' && p.responseStatusCode === undefined) {
      c.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: b64(doc) }, sessionId);
    } else if (u.pathname === '/settings' && p.responseStatusCode !== undefined) {
      const body = await c.send('Fetch.getResponseBody', { requestId: p.requestId }, sessionId);
      const j = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
      (j.settings || j).layers = settingsLayers;
      c.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: b64(JSON.stringify(j)) }, sessionId);
    } else {
      c.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId);
    }
  };
  c.on(h);
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Fetch.enable', { patterns: [{ urlPattern: opt.server + '/*', requestStage: 'Request' }, { urlPattern: opt.server + '/settings*', requestStage: 'Response' }] }, sessionId);
  await c.send('Page.navigate', { url: `${opt.server}/?layer=${encodeURIComponent(SURFACE)}` }, sessionId);
  await sleep(opt.wait * 1000);
  const probe = await c.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { const s = document.querySelector('.layer-slot'); const t = s && s.querySelector('[data-dashboard-widget]');
      return { slots: document.querySelectorAll('.layer-slot').length, text: t ? t.textContent.trim().length : 0,
        elements: t ? t.querySelectorAll('*').length : 0, overflowX: document.documentElement.scrollWidth > innerWidth,
        lite: document.documentElement.hasAttribute('data-layer-lite'), html: s ? s.innerHTML.slice(0, 600) : '' }; })()`,
  }, sessionId);
  if (opt.shots && tile) {
    const shot = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1920 * 0.5, height: 1080 * 0.7, scale: 1 } }, sessionId);
    if (shot && shot.data) writeFileSync(path.join(opt.shots, tile + '.png'), Buffer.from(shot.data, 'base64'));
  }
  await c.send('HeapProfiler.collectGarbage', {}, sessionId);
  const rows = await memoryRows(c);
  const newPids = rows.map((r) => r.pid).filter((p) => !pidsBefore.has(p));
  c.off(h);
  await c.send('Target.disposeBrowserContext', { browserContextId });
  const page = probe.result && probe.result.value ? probe.result.value : { slots: 0, text: 0, elements: 0 };
  return { tile: tile || '(none)', ...page, errors, blocked, mb: pageFootprint(rows, newPids) };
}

async function main() {
  const opt = args(process.argv.slice(2));
  const files = {
    lite: readFileSync(path.join(ROOT, 'layer-lite.html'), 'utf8'),
    dashboard: readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
  };
  await closeLeftover();
  const profile = mkdtempSync(path.join(tmpdir(), 'xenon-tile-probe-'));
  const browser = spawn(browserPath(opt.browser), ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`,
    '--mute-audio', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  let c = null;
  try {
    c = cdp((await connect()).webSocketDebuggerUrl);
    await c.open;
    const base = await sample(c, opt, '', files);
    if (opt.write) record(opt.write, base.mb, null);
    for (const tile of opt.tiles) {
      const s = await sample(c, opt, tile, files);
      s.deltaMB = s.mb != null && base.mb != null ? s.mb - base.mb : null;
      s.verdict = verdict(s);
      if (opt.write) record(opt.write, base.mb, s);
      const writes = s.blocked.length ? `  writes refused: ${[...new Set(s.blocked)].join(', ')}` : '';
      console.log(`${tile.padEnd(13)} ${s.verdict.padEnd(10)} +${s.deltaMB} MB  text ${s.text}  ${s.errors.slice(0, 2).join(' | ')}${writes}`);
      if (opt.html) console.log(s.html);
    }
    console.log(`empty light page: ${base.mb} MB`);
  } finally {
    if (c) await closeBrowser(c).catch(() => {});
    killTree(browser);
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
