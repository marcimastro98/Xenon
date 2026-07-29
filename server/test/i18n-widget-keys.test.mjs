import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// A translation key that does not exist is invisible until someone hits the code
// path that shows it, and then it prints the key. That is what shipped: the
// YouTube Live widget asked for `twitch_action_failed`, which had never existed,
// so the first failure in the stream-key button rendered the literal string
// "twitch_action_failed" in the middle of the card — a message that told the user
// nothing and pointed at the wrong integration. Three more of its error strings
// were missing the same way and nothing had reached them yet.
//
// Nothing in the app surfaces this: t() resolves, the DOM updates, the text is
// simply a key. So every key the client asks for is checked here against the
// English block, which is the fallback every language lands on.
const __dirname = dirname(fileURLToPath(import.meta.url));
const JS_DIR = join(__dirname, '..', 'js');
const SRC = readFileSync(join(JS_DIR, 'i18n.js'), 'utf8');

// Resolving the object is the only exact answer, and a regex over the source
// cannot be. Keys are written several to a line in the two big literals, one per
// line in the appended groups, quoted in some blocks and bare in others, and the
// nine other languages reach most of theirs through `...i18n.en`. The previous
// scan was anchored to the start of a line, so on a line like
//   lgt_empty: '…', lgt_auto: 'Auto', lgt_devices: 'Devices', lgt_on: 'On',
// it saw `lgt_empty` and nothing else. That is why eight keys sat in KNOWN_GAPS
// below for releases while being present AND fully translated in all eleven
// languages: the list of "what is broken" had become a list of what the test
// could not see, which is the one thing it must never be.
//
// Everything above the first top-level `function` is data — object literals and
// Object.assign calls, no DOM — so evaluating that half resolves spreads and the
// per-feature groups for free, exactly as the browser does.
function englishKeys() {
  const cut = SRC.search(/^function /m);
  assert.ok(cut > 0, 'the data/behaviour split in i18n.js moved');
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(0, cut) + ';globalThis.__i18n = i18n;', ctx, { filename: 'i18n.js' });
  const en = ctx.__i18n && ctx.__i18n.en;
  assert.ok(en, 'i18n.en did not resolve');
  const keys = new Set(Object.keys(en));
  assert.ok(keys.size > 500, `only ${keys.size} English keys found — the scan broke`);
  return keys;
}

// Every `t('some_key'` in a client module, plus the key tables the widgets look
// up indirectly (`const SOMETHING_KEY = { a: 'some_key', ... }`), which is how
// three of the four missing ones got in.
function keysUsedBy(file) {
  const src = readFileSync(join(JS_DIR, file), 'utf8');
  const used = new Set();
  // The closing quote must be followed by `)` or `,`: several widgets build a key
  // by concatenation (`t('wl_mix_' + n)`), and the prefix on its own is not a key.
  for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'\s*[),]/g)) used.add(m[1]);
  for (const m of src.matchAll(/[A-Z][A-Z0-9_]*_KEY\s*=\s*\{([^}]*)\}/g)) {
    for (const k of m[1].matchAll(/'([a-z][a-z0-9_]+)'/g)) used.add(k[1]);
  }
  return used;
}

// EMPTY, and it should stay that way. It held fourteen entries: six were real
// (back, mic, cw_collapse, cw_perm_expand_val — filled in for all eleven
// languages in v4.11) and eight were never broken at all, only invisible to the
// old line-anchored scan described above.
//
// Delete a line as you fill the key in; never add one to make this pass. If an
// entry here would be a key the scan cannot see rather than a key that is
// missing, fix the scan instead — that is the failure this list already had once.
const KNOWN_GAPS = new Set([]);

test('every translation key a widget asks for exists in English', () => {
  const have = englishKeys();
  const files = readdirSync(JS_DIR).filter(f => f.endsWith('-widget.js'));
  assert.ok(files.length >= 10, `only ${files.length} widget modules found — the scan broke`);
  const missing = [];
  for (const f of files) {
    for (const k of keysUsedBy(f)) {
      const id = `${f}: ${k}`;
      if (!have.has(k) && !KNOWN_GAPS.has(id)) missing.push(id);
    }
  }
  assert.deepEqual(missing, [], 'these keys would render as their own name:\n' + missing.join('\n'));
});

// The list above is a record of what is broken, so an entry that is no longer
// broken has to leave it — otherwise it slowly becomes a list of things that were
// fixed and nobody trusts it any more.
test('the known-gap list has no entries that were since fixed', () => {
  const have = englishKeys();
  const stale = [...KNOWN_GAPS].filter(id => have.has(id.split(': ')[1]));
  assert.deepEqual(stale, [], 'these keys exist now and should leave KNOWN_GAPS');
});
