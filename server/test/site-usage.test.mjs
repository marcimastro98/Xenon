// The site's anonymous feature counts (docs/analytics.js → the hub's POST /usage).
// Runs the real script against a small DOM stand-in: what is counted, what is
// sent, that nothing is written on the device, and that the ids are the ones the
// hub accepts (the hub drops every other id without a word).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(here, '..', '..', 'docs', 'analytics.js'), 'utf8');
const HUB = process.env.HUB_REPO || path.resolve(here, '..', '..', '..', 'xenon-supporter-hub');
const HUB_FEATURES = path.join(HUB, 'src', 'usage-features.js');

function load({ href = 'https://xenon-app.com/', session = null, framed = false } = {}) {
  const url = new URL(href);
  const listeners = {};
  const docListeners = {};
  const beacons = [];
  const others = [];
  const writes = [];
  const timers = [];
  const observed = [];
  let observer = null;
  const sections = ['install', 'screens', 'make', 'faq'].map((id) => ({ id, tagName: 'SECTION' }));
  const store = new Map(session ? [['xenon.maker.session', JSON.stringify(session)]] : []);
  const window = {
    innerHeight: 800,
    addEventListener: (n, fn) => { (listeners[n] ||= []).push(fn); },
  };
  window.top = framed ? {} : window;
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    addEventListener: (n, fn) => { (docListeners[n] ||= []).push(fn); },
    querySelectorAll: (sel) => (sel === 'section[id]' ? sections : []),
  };
  const ctx = vm.createContext({
    window,
    document,
    location: { href: url.href, origin: url.origin, pathname: url.pathname, hostname: url.hostname },
    navigator: { sendBeacon: (u, body) => { if (body) beacons.push({ url: u, body: JSON.parse(body) }); else others.push(u); return true; } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => writes.push([k, v]),
      removeItem: (k) => writes.push([k, null]),
    },
    IntersectionObserver: class {
      constructor(cb) { this.cb = cb; observer = this; }
      observe(el) { observed.push(el.id); }
      unobserve() {}
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    fetch: () => { throw new Error('fetch must not be needed when sendBeacon works'); },
    URL,
    JSON,
    Date,
    Math,
  });
  ctx.addEventListener = window.addEventListener;
  vm.runInContext(SOURCE, ctx);
  const click = (href) => {
    const a = { href: new URL(href, url).href, getAttribute: () => href, hasAttribute: () => false };
    const target = { closest: (sel) => (sel === 'a[href]' ? a : null) };
    for (const fn of docListeners.click || []) fn({ target });
  };
  const tagged = (name) => {
    const elm = { attributes: [], getAttribute: (k) => (k === 'data-track' ? name : null) };
    const target = { closest: (sel) => (sel === '[data-track]' ? elm : null) };
    for (const fn of docListeners.click || []) fn({ target });
  };
  const hide = () => { for (const fn of listeners.pagehide || []) fn(); };
  const see = (id, ratio, rectHeight = 100) => observer.cb([{ target: { id }, isIntersecting: true, intersectionRatio: ratio, intersectionRect: { height: rectHeight } }]);
  return { ctx, click, tagged, hide, see, beacons, others, writes, timers, observed };
}

const events = (beacons) => beacons.flatMap((b) => b.body.events.map((e) => [e.f, e.n]));

test('clicks to the demo, the Maker and Support are counted and sent as one batch', () => {
  const s = load({ href: 'https://xenon-app.com/it/' });
  s.click('/demo/');
  s.click('../maker/');
  s.click('https://www.buymeacoffee.com/marcimastro98');
  s.click('https://xenon-supporter-hub.xenonedge.workers.dev/go/support');
  s.click('/demo/');
  s.click('https://example.com/demo/');
  s.click('/guides/');
  assert.equal(s.beacons.length, 0, 'nothing sent before the page is left');
  assert.equal(s.timers.filter((t) => t.ms === 60000).length, 1, 'one timer for the first count');
  s.hide();
  assert.equal(s.beacons.length, 1);
  assert.equal(s.beacons[0].url, 'https://xenon-supporter-hub.xenonedge.workers.dev/usage');
  assert.equal(s.beacons[0].body.surface, 'site');
  assert.equal(s.beacons[0].body.tier, 'free');
  assert.deepEqual(events(s.beacons).sort(), [['demo.click', 2], ['maker.click', 1], ['support.click', 2]]);
  s.hide();
  assert.equal(s.beacons.length, 1, 'an empty queue sends nothing');
});

test('home sections are counted once per view, only from the allowlist, only on the home', () => {
  const s = load({ href: 'https://xenon-app.com/' });
  assert.deepEqual(s.observed, ['install', 'screens', 'faq'], 'an id outside the list is not watched');
  s.see('install', 0.2);
  s.see('install', 0.6);
  s.see('install', 0.9);
  s.see('screens', 0.1, 500); // a tall section: half a screen of it counts
  s.hide();
  assert.deepEqual(events(s.beacons).sort(), [['home.install', 1], ['home.screens', 1]]);

  const guide = load({ href: 'https://xenon-app.com/guides/second-screen/' });
  assert.deepEqual(guide.observed, []);
  const pages = load({ href: 'https://marcimastro98.github.io/xenon-edge/ko/' });
  assert.equal(pages.observed.length, 3);
});

test('the demo counts its own opening, but not inside the Maker frame', () => {
  const page = load({ href: 'https://xenon-app.com/demo/' });
  page.hide();
  assert.deepEqual(events(page.beacons), [['demo.open', 1]]);
  const framed = load({ href: 'https://xenon-app.com/demo/?maker', framed: true });
  framed.hide();
  assert.equal(framed.beacons.length, 0);
});

test('the catalog and the download beacon count through the same queue', () => {
  const s = load({ href: 'https://xenon-app.com/catalog/' });
  s.ctx.window.xusage('catalog.entry');
  s.ctx.window.xusage('not.a.feature');
  s.tagged('download_click');
  s.hide();
  assert.deepEqual(events(s.beacons).sort(), [['catalog.entry', 1], ['download.click', 1]]);
  assert.equal(s.others.length, 1, 'the download counter beacon still goes out');
});

test('tier: supporter only for a live supporter session of the Maker, read and never written', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const cases = [
    [{ token: 't', exp }, 'supporter'],
    [{ token: 't', exp, trial: true }, 'free'],
    [{ token: 't', exp, sparks: true }, 'free'],
    [{ token: 't', exp: 1 }, 'free'],
    [null, 'free'],
  ];
  for (const [session, tier] of cases) {
    const s = load({ href: 'https://xenon-app.com/', session });
    s.click('/maker/');
    s.hide();
    assert.equal(s.beacons[0].body.tier, tier, JSON.stringify(session));
    assert.deepEqual(s.writes, [], 'nothing is stored on the device');
  }
});

test('the page wires the catalog hook and the analytics script stays parse-clean', () => {
  const cat = readFileSync(path.join(here, '..', '..', 'docs', 'catalog', 'index.html'), 'utf8');
  assert.match(cat, /if \(!fromHash && typeof window\.xusage === 'function'\) window\.xusage\('catalog\.entry'\);/);
  assert.doesNotThrow(() => new vm.Script(SOURCE));
});

test('every site id is one the hub accepts', { skip: !existsSync(HUB_FEATURES) && 'hub checkout not found' }, async () => {
  const hub = await import(pathToFileURL(HUB_FEATURES).href);
  const list = /const SITE_FEATURES = \[([^\]]+)\]/.exec(SOURCE)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const sections = /const HOME_SECTIONS = \[([^\]]+)\]/.exec(SOURCE)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const site = [...list, ...sections.map((x) => 'home.' + x)].sort();
  assert.deepEqual(site, [...hub.USAGE_FEATURES.site].sort());
});
