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
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

function widgetIds() {
  const m = SRC.match(/const DASHBOARD_WIDGET_IDS = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(m, 'DASHBOARD_WIDGET_IDS declaration not found');
  return m[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
}

function defaultWidgetKeys() {
  const start = SRC.indexOf('const DEFAULT_DASHBOARD_LAYOUT = Object.freeze({');
  assert.ok(start >= 0, 'DEFAULT_DASHBOARD_LAYOUT declaration not found');
  const wStart = SRC.indexOf('widgets: Object.freeze({', start);
  const wEnd = SRC.indexOf('groups: Object.freeze({', wStart);
  const block = SRC.slice(wStart, wEnd);
  return new Set([...block.matchAll(/\n\s+([a-z][a-z0-9]*):\s+Object\.freeze\(\{ x:/gi)].map(m => m[1]));
}

test('every DASHBOARD_WIDGET_IDS entry has a geometry default (no 500 on /settings)', () => {
  const ids = widgetIds();
  const defaults = defaultWidgetKeys();
  const missing = ids.filter(id => !defaults.has(id));
  assert.deepEqual(missing, [], `widget ids without a DEFAULT_DASHBOARD_LAYOUT.widgets default: ${missing.join(', ')}`);
});
