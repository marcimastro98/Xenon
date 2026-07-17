// The minimal-topbar island segment list lives in THREE places that must agree:
// the renderer's ISLAND_SEG_IDS (js/topbar-minimal.js), the client settings
// normalizer's canonical list (js/settings.js) and its server twin
// (server.js TOPBAR_ISLAND_IDS). The normalizers are allowlists — a segment the
// renderer draws but they omit is stripped from `items` on the next save, so the
// segment silently loses its stored order/visibility. Every id must also carry a
// label, or the Settings island editor renders a raw id at the user.
// Pin all four so they can't drift (same guard shape as sdk-grant-cats-sync).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

// Pull a single-quoted string array out of `<name> = [...]` source text.
function arrayLiteral(src, pattern, what) {
  const m = src.match(pattern);
  assert.ok(m, what + ' not found');
  return m[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
}

const renderer = arrayLiteral(
  read('server', 'js', 'topbar-minimal.js'),
  /ISLAND_SEG_IDS\s*=\s*\[([^\]]*)\]/,
  'ISLAND_SEG_IDS in topbar-minimal.js',
);

test('settings.js normalizeTopbarClock covers every island segment the renderer draws', () => {
  const client = arrayLiteral(
    read('server', 'js', 'settings.js'),
    /normalizeTopbarClock\(value\)\s*\{\s*const canonical\s*=\s*\[([^\]]*)\]/,
    'canonical list in settings.js normalizeTopbarClock',
  );
  assert.deepEqual([...client].sort(), [...renderer].sort());
});

test('server.js TOPBAR_ISLAND_IDS mirrors the client canonical list', () => {
  const server = arrayLiteral(
    read('server', 'server.js'),
    /TOPBAR_ISLAND_IDS\s*=\s*\[([^\]]*)\]/,
    'TOPBAR_ISLAND_IDS in server.js',
  );
  assert.deepEqual([...server].sort(), [...renderer].sort());
});

test('every island segment has an editor label key, and that key exists in i18n', () => {
  const labelsSrc = read('server', 'js', 'settings.js')
    .match(/TOPBAR_ISLAND_LABELS\s*=\s*\{([^}]*)\}/);
  assert.ok(labelsSrc, 'TOPBAR_ISLAND_LABELS not found in settings.js');
  const labels = new Map();
  for (const m of labelsSrc[1].matchAll(/(\w+):\s*'([^']+)'/g)) labels.set(m[1], m[2]);
  const i18n = read('server', 'js', 'i18n.js');
  for (const id of renderer) {
    const key = labels.get(id);
    assert.ok(key, 'island segment "' + id + '" has no TOPBAR_ISLAND_LABELS entry');
    // en is the guaranteed fallback tier in i18n.js's t(); a key missing there
    // would render as the raw key name.
    assert.ok(new RegExp('"?' + key + '"?:\\s*[\'"]').test(i18n),
      'label key "' + key + '" is missing from i18n.js');
  }
});
