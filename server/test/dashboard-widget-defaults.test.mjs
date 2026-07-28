import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for a real production bug: 'notifications' was added to
// DASHBOARD_WIDGET_IDS without a matching DEFAULT_DASHBOARD_LAYOUT.widgets entry,
// so normalizeDashboardGeom() dereferenced an undefined fallback (`fallbackItem.x`)
// and EVERY GET/POST /settings answered 500 — the client could neither hydrate nor
// save settings. Every widget id MUST have a geometry default. server.js boots a
// server on require, so we assert against its source text instead of importing it.
//
// This invariant lives in TWO files that must stay in sync: server/server.js AND
// server/js/settings.js (the client mirror). 'stocks' was once added to the client
// DASHBOARD_WIDGET_IDS without its client geometry default, throwing the same
// `reading 'x'` TypeError in the browser's normalizeDashboardGeom — so both files
// are checked here.
const __dirname = dirname(fileURLToPath(import.meta.url));

function widgetIds(src) {
  const m = src.match(/const DASHBOARD_WIDGET_IDS = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(m, 'DASHBOARD_WIDGET_IDS declaration not found');
  return m[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
}

function defaultWidgetKeys(src) {
  const start = src.indexOf('const DEFAULT_DASHBOARD_LAYOUT = Object.freeze({');
  assert.ok(start >= 0, 'DEFAULT_DASHBOARD_LAYOUT declaration not found');
  const wStart = src.indexOf('widgets: Object.freeze({', start);
  const wEnd = src.indexOf('groups: Object.freeze({', wStart);
  const block = src.slice(wStart, wEnd);
  return new Set([...block.matchAll(/\n\s+([a-z][a-z0-9]*):\s+Object\.freeze\(\{ x:/gi)].map(m => m[1]));
}

for (const rel of ['server.js', join('js', 'settings.js')]) {
  test(`${rel}: every DASHBOARD_WIDGET_IDS entry has a geometry default (no 500 / no client crash)`, () => {
    const src = readFileSync(join(__dirname, '..', rel), 'utf8');
    const ids = widgetIds(src);
    const defaults = defaultWidgetKeys(src);
    const missing = ids.filter(id => !defaults.has(id));
    assert.deepEqual(missing, [], `${rel} widget ids without a DEFAULT_DASHBOARD_LAYOUT.widgets default: ${missing.join(', ')}`);
  });
}

// The SAME bug, one layer down, and it shipped: DASHBOARD_CARD_IDS.youtube
// listed 'playlists' while DEFAULT_DASHBOARD_LAYOUT.cards.youtube had only
// 'info' and 'actions'. normalizeDashboardLayout() iterates the ID list and
// reads a default for each id, so the missing entry threw `reading 'order'` —
// and because normalizeHubSettings is how the whole settings blob is rebuilt,
// the damage was nothing like a misplaced card: `GET /settings` answered 500 and
// the server's in-memory settings stayed at factory defaults. That silently
// switched OFF every server-owned flag, paired-device access included, while
// the file on disk still said it was on, so a phone that had worked for hours
// started getting the plain 403 of a build without the feature.
//
// Widgets were already covered above. Cards were not, which is exactly how this
// one got through.
function cardIds(src) {
  const m = src.match(/const DASHBOARD_CARD_IDS = Object\.freeze\(\{([\s\S]*?)\n\}\)/);
  assert.ok(m, 'DASHBOARD_CARD_IDS declaration not found');
  const out = {};
  for (const line of m[1].split('\n')) {
    const g = line.match(/^\s*([a-z][a-z0-9]*):\s*\[([^\]]*)\]/i);
    if (g) out[g[1]] = (g[2].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
  }
  assert.ok(Object.keys(out).length > 3, 'card group extraction broke');
  return out;
}

function defaultCardKeys(src) {
  const start = src.indexOf('const DEFAULT_DASHBOARD_LAYOUT = Object.freeze({');
  assert.ok(start >= 0, 'DEFAULT_DASHBOARD_LAYOUT declaration not found');
  const cStart = src.indexOf('cards: Object.freeze({', start);
  const cEnd = src.indexOf('tabs: Object.freeze({', cStart);
  assert.ok(cStart >= 0 && cEnd > cStart, 'cards block not found');
  const out = {};
  let group = null;
  for (const line of src.slice(cStart, cEnd).split('\n')) {
    const g = line.match(/^\s{4}([a-z][a-z0-9]*):\s*Object\.freeze\(\{\s*$/i);
    if (g) { group = g[1]; out[group] = new Set(); continue; }
    const c = line.match(/^\s{6}([a-z][a-z0-9]*):\s*Object\.freeze\(\{\s*order:/i);
    if (c && group) out[group].add(c[1]);
  }
  return out;
}

// BOTH files, for the same reason the widget test above checks both: the client
// keeps its own mirror of these constants and its own normalizer. Fixing only
// the server left the identical TypeError being thrown in the browser, inside
// applyHubSettings — which runs on every hydrate and every settings event, so it
// landed before the dashboard had finished starting up.
for (const rel of ['server.js', join('js', 'settings.js')]) {
  test(`${rel}: every DASHBOARD_CARD_IDS entry has a layout default (no 500, no settings reset)`, () => {
    const src = readFileSync(join(__dirname, '..', rel), 'utf8');
    const ids = cardIds(src);
    const defaults = defaultCardKeys(src);
    const missing = [];
    for (const [group, list] of Object.entries(ids)) {
      assert.ok(defaults[group], rel + ': no DEFAULT_DASHBOARD_LAYOUT.cards.' + group);
      for (const id of list) if (!defaults[group].has(id)) missing.push(group + '.' + id);
    }
    assert.deepEqual(missing, [], rel + ' card ids without a default: ' + missing.join(', '));
  });
}

// The fence behind the data. Even with the lists in step, a normalizer for
// PERSISTED data must never throw: it is the one function standing between a
// file on disk and the whole settings blob, on both sides.
for (const rel of ['server.js', join('js', 'settings.js')]) {
  test(`${rel}: normalizeDashboardItem survives a missing default instead of throwing`, () => {
    const src = readFileSync(join(__dirname, '..', rel), 'utf8');
    const fn = src.slice(src.indexOf('function normalizeDashboardItem('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.doesNotMatch(body, /fallbackItem\.(order|size|visible)/,
      rel + ': normalizeDashboardItem still dereferences fallbackItem directly, so one missing default takes the store down');
  });
}
