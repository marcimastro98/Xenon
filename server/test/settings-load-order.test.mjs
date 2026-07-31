import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = join(HERE, '..', 'js', 'settings.js');

// settings.js normalizes the stored settings at module load — `let hubSettings =
// loadHubSettings();`, near the top of an 8000-line file — and everything that
// normalize touches has to be initialized by then.
//
// A function DECLARATION is hoisted and a `const` is not, so a lookup table that
// reads perfectly well beside the function that uses it is unreachable from a
// call made earlier in the file. It does not fail quietly: the ReferenceError
// takes loadHubSettings() with it, `hubSettings` is never assigned, and every
// module that reads it fails in turn. The dashboard boots with no tiles and a
// console full of "hubSettings is not defined", none of which names the const
// that actually caused it.
//
// This has now happened three times — AMBIENT_IDLE_MINUTES, SURFACE_KINDS and
// NEWS_DEFAULT_TOPIC — and the file carries a prose warning about it that is
// easy to walk past, because the natural place to put a table is next to its
// function. Prose does not fail a build. This does.
//
// It is a static check on purpose: evaluating settings.js needs a browser and
// half the other client modules, so the cheap version of that test would stub
// its way past the very thing it is meant to catch.

const src = readFileSync(SETTINGS, 'utf8');

/**
 * Comments and string literals removed, LENGTH PRESERVED so every offset still
 * points at the same place in the original. Without this, a const named in a
 * comment inside a normalizer reads as a use of it — and the comment explaining
 * the hazard would be the thing that trips the check.
 */
function stripped(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // `[^:]` keeps the strip from eating the rest of a line at the // of a URL.
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
    // Every one of these is LINE-BOUNDED, template literals included, and that
    // is not laziness. A multi-line template rule pairs backticks across the
    // file, and settings.js contains an odd number of them (one lives inside a
    // regex character class) — so the last pair swallowed ~40kB of real code
    // including the functions this check reads. Over-stripping does not fail
    // loudly, it just quietly stops checking, which is worse than the false
    // positive a missed multi-line template could cause. The assertion in
    // lateConstsUsedAtLoad() is what caught it, and it stays for that reason.
    .replace(/'(?:[^'\\\n]|\\.)*'/g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
    .replace(/`[^`\n]*`/g, blank);
}

/** The body of `function NAME(...) { … }`, by brace matching. */
function functionBodies(code) {
  const out = new Map();
  const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', re.lastIndex);
    if (open < 0) continue;
    let depth = 0;
    let i = open;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) break;
    }
    out.set(m[1], code.slice(open, i));
  }
  return out;
}

/** Top-level `const NAME = …`, with the offset it is initialized at. */
function topLevelConsts(code) {
  const out = new Map();
  const re = /^const\s+([A-Za-z_$][\w$]*)\s*=/gm;
  let m;
  while ((m = re.exec(code))) out.set(m[1], m.index);
  return out;
}

/** Everything reachable from `roots` through plain calls, bounded. */
function reachable(bodies, roots, maxHops = 5) {
  const seen = new Set(roots);
  let frontier = [...roots];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next = [];
    for (const name of frontier) {
      const body = bodies.get(name);
      if (!body) continue;
      for (const called of body.match(/[A-Za-z_$][\w$]*(?=\s*\()/g) || []) {
        if (bodies.has(called) && !seen.has(called)) { seen.add(called); next.push(called); }
      }
    }
    frontier = next;
  }
  return seen;
}

const uses = (body, name) => new RegExp('(^|[^\\w$.])' + name + '(?![\\w$])').test(body);

/**
 * The check itself, as a function so the test below can also run it against a
 * source it fabricates — a detector nobody has watched fail is a detector
 * nobody should trust.
 */
function lateConstsUsedAtLoad(text) {
  const code = stripped(text);
  const initAt = code.indexOf('let hubSettings = loadHubSettings()');
  assert.notEqual(initAt, -1, 'the load-time normalize was not located in settings.js');

  const bodies = functionBodies(code);
  const consts = topLevelConsts(code);
  const late = [...consts].filter(([, at]) => at > initAt).map(([name]) => name);

  const roots = ['loadHubSettings', 'normalizeSettings'].filter((n) => bodies.has(n));
  assert.ok(roots.length, 'neither loadHubSettings nor normalizeSettings was found');

  const found = [];
  for (const fn of reachable(bodies, roots)) {
    const body = bodies.get(fn);
    for (const name of late) if (uses(body, name)) found.push({ fn, name });
  }
  return found;
}

test('nothing the initial settings normalize touches is declared after it runs', () => {
  const found = lateConstsUsedAtLoad(src);
  const say = found.map((f) => `${f.name} (read by ${f.fn}) `).join(', ');
  assert.deepEqual(found, [],
    'these are in the temporal dead zone when loadHubSettings() runs, which aborts it and '
    + 'boots the dashboard empty — move them above `let hubSettings = loadHubSettings();`, '
    + 'beside SURFACE_KINDS: ' + say);
});

test('the check actually catches the shape it is written for', () => {
  // The exact bug, in miniature: a hoisted function reached by the initial
  // normalize, reading a const declared further down the file.
  const broken = [
    'function normalizeSettings(v) { return { news: normalizeNewsClient(v.news) }; }',
    'function loadHubSettings() { return normalizeSettings({}); }',
    'let hubSettings = loadHubSettings();',
    'function normalizeNewsClient(v) { return defaultFeeds("en"); }',
    'function defaultFeeds(l) { return LATE_TABLE[l]; }',
    'const LATE_TABLE = { en: 1 };',
  ].join('\n');
  assert.deepEqual(lateConstsUsedAtLoad(broken), [{ fn: 'defaultFeeds', name: 'LATE_TABLE' }],
    'the detector missed a const two hops from the initial normalize');

  // And the fix reads clean, so this cannot pass by refusing everything.
  const fixed = [
    'const LATE_TABLE = { en: 1 };',
    'function normalizeSettings(v) { return { news: normalizeNewsClient(v.news) }; }',
    'function loadHubSettings() { return normalizeSettings({}); }',
    'let hubSettings = loadHubSettings();',
    'function normalizeNewsClient(v) { return defaultFeeds("en"); }',
    'function defaultFeeds(l) { return LATE_TABLE[l]; }',
  ].join('\n');
  assert.deepEqual(lateConstsUsedAtLoad(fixed), []);

  // A const named only in a COMMENT inside a normalizer is not a use of it.
  // The note explaining this very hazard sits in one of those functions.
  const commented = [
    'function normalizeSettings(v) { /* LATE_TABLE lives further down */ return v; }',
    'function loadHubSettings() { return normalizeSettings({}); }',
    'let hubSettings = loadHubSettings();',
    'const LATE_TABLE = { en: 1 };',
  ].join('\n');
  assert.deepEqual(lateConstsUsedAtLoad(commented), []);
});

test('the news table is above the line, and its builder can be below it', () => {
  const code = stripped(src);
  const initAt = code.indexOf('let hubSettings = loadHubSettings()');
  const tableAt = code.indexOf('const NEWS_DEFAULT_TOPIC');
  assert.notEqual(tableAt, -1, 'NEWS_DEFAULT_TOPIC is gone — did the mirror move?');
  assert.ok(tableAt < initAt,
    'the topic table is read while the first feed set is seeded, so it must be initialized first');
  // The function may stay next to normalizeNewsClient: a declaration is hoisted,
  // which is exactly the asymmetry that made the bug confusing.
  assert.ok(code.indexOf('function defaultNewsFeedsClient') > initAt,
    'nothing forces the builder up here, and saying so keeps the next person from moving both');
});

// ── And the same question asked of the running code ──────────────────────────
//
// The check above is static, so it can be wrong in both directions. This one
// actually LOADS settings.js the way the page does — against the real utils.js,
// state.js, i18n.js and theme-palette.js it depends on — with a settings blob
// already in storage, and asks the only question that matters: did the settings
// survive.
//
// That is the shape the bug really had. loadHubSettings() is
// `try { normalizeSettings(stored) } catch { return normalizeSettings(null) }`,
// which is the right thing for a corrupt blob and the reason a TDZ
// ReferenceError produced NO error anywhere: it was swallowed, the user's whole
// saved configuration was replaced by defaults, and the server copy arriving a
// moment later hid what had happened. Measured here before the fix:
// "Cannot access 'SDK_PACKAGE_ID_RE' before initialization", for every user with
// a community widget on a tile.

const DEPS = ['utils.js', 'toast.js', 'state.js', 'i18n.js', 'theme-palette.js'];
const DEP_SRC = DEPS.map((f) => [f, readFileSync(join(HERE, '..', 'js', f), 'utf8')]);

/** A sandbox with the handful of browser globals this chain touches. */
function makeSandbox(store, probe) {
  const dom = makeDom();
  const sandbox = {
    __probe: probe,
    document: dom.document,
    window: null,
    console: { log() {}, warn() {}, error() {}, info() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: { language: 'en-US' },
    location: { origin: 'http://127.0.0.1:3030', protocol: 'http:', hostname: '127.0.0.1' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    MutationObserver: dom.MutationObserver,
    requestAnimationFrame: () => 1,
    CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    crypto: { randomUUID: () => 'x', getRandomValues: (a) => a },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const [file, code] of DEP_SRC) {
    try { vm.runInContext(code, sandbox, { filename: file }); }
    catch (e) { assert.fail('a dependency of settings.js would not load: ' + file + ' - ' + e.message); }
  }
  return sandbox;
}

/**
 * settings.js, with two things made observable: the error its load-time catch
 * swallows, and `hubSettings` itself (a top-level `let` is not a property of
 * the global, which is half of why this was invisible from the outside).
 */
function instrumented() {
  const crlf = src.includes('  } catch {\r\n    return normalizeSettings(null);');
  const CATCH = crlf
    ? '  } catch {\r\n    return normalizeSettings(null);'
    : '  } catch {\n    return normalizeSettings(null);';
  assert.ok(src.includes(CATCH),
    'loadHubSettings() no longer has the catch this test reads - if its shape changed, update this');
  return src.replace(CATCH, '  } catch (e) { __probe.swallowed = String(e && e.message);\n    return normalizeSettings(null);')
    + '\n;globalThis.__hub = hubSettings;';
}

/** Load the real client chain against a stored blob and report what came back. */
function loadWith(stored) {
  const store = new Map();
  if (stored) store.set('xeneonedge.settings.v1', JSON.stringify(stored));
  const probe = { swallowed: null };
  const sandbox = makeSandbox(store, probe);
  let fatal = null;
  try { vm.runInContext(instrumented(), sandbox, { filename: 'settings.js' }); }
  catch (e) { fatal = e.message; }
  return { swallowed: probe.swallowed, fatal, hub: sandbox.__hub };
}

test('settings.js loads clean, and what was saved is still there afterwards', () => {
  // Each of these is a stored shape that reaches a different normalizer, which
  // is what decides whether a late const is in scope by the time it is read.
  const cases = [
    ['nothing stored', null, (hub) => assert.ok(hub, 'no settings object at all')],
    ['an SDK widget on a tile',
      { sdkWidgets: { assign: { custom: 'my-pkg' }, grants: { 'my-pkg': { streams: ['system'] } } } },
      (hub) => {
        assert.equal(hub.sdkWidgets.assign.custom, 'my-pkg',
          'the widget assignment was dropped - the whole blob fell back to defaults');
        // Spread into a host array first: a value built inside the vm carries that
        // realm's Array.prototype, and deepStrictEqual refuses it on identity.
        assert.deepEqual([...hub.sdkWidgets.grants['my-pkg'].streams], ['system']);
      }],
    ['a host the user typed into a widget slot',
      { sdkWidgets: { grants: { 'my-pkg': { userHosts: { api: { host: 'example.com', port: 8080 } } } } } },
      (hub) => {
        const slot = hub.sdkWidgets.grants['my-pkg'].userHosts.api;
        assert.equal(slot.host, 'example.com');
        assert.equal(slot.port, 8080);
      }],
    ['a pasted SVG wallpaper',
      { backgroundMedia: { url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', name: 'mine' } },
      (hub) => {
        assert.ok(hub.backgroundMedia, 'the wallpaper was dropped');
        assert.match(String(hub.backgroundMedia.url), /^data:image\/svg\+xml;base64,/);
      }],
    ['a per-device lighting mode',
      { lighting: { deviceModes: { 'dev-1': { mode: 'color', color: '#1ed760' } } } },
      (hub) => {
        assert.equal(hub.lighting.deviceModes['dev-1'].mode, 'color');
        assert.equal(hub.lighting.deviceModes['dev-1'].color, '#1ed760');
      }],
    ['a news feed list the user chose',
      { news: { feeds: [{ id: 'ilpost', type: 'source', name: 'Il Post' }], refreshSec: 600 } },
      (hub) => assert.deepEqual([...hub.news.feeds].map((f) => f.id), ['ilpost'])],
  ];

  for (const [name, stored, check] of cases) {
    const { swallowed, fatal, hub } = loadWith(stored);
    assert.equal(fatal, null, 'settings.js threw on load with ' + name + ': ' + fatal);
    assert.equal(swallowed, null,
      'loadHubSettings() swallowed an error with ' + name + ', so every saved setting was '
      + 'silently replaced by defaults: ' + swallowed);
    assert.ok(hub, 'hubSettings was never assigned with ' + name);
    check(hub);
  }
});

test('a genuinely corrupt blob still falls back instead of taking the page down', () => {
  // The catch is not the bug and must stay. This is the job it is there for.
  const store = new Map([['xeneonedge.settings.v1', '{ not json at all']]);
  const sandbox = makeSandbox(store, {});
  vm.runInContext(src + '\n;globalThis.__hub = hubSettings;', sandbox, { filename: 'settings.js' });
  assert.ok(sandbox.__hub, 'a corrupt blob must give defaults, not a dead page');
});
