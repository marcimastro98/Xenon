// A Deck key that fails now says why, instead of only flashing red.
//
// Reported on Discord: an "Open app" key on macOS with the path
// /Applications/Finder.app — a real bundle, correctly spelled — "flashes red
// and nothing happens". The dispatcher knew exactly why: /actions/run answers
// {ok:false,error} with `not_found`, `bad_app_path`, `launch_failed` and the
// rest. runAction read that body and threw the reason away on the next line
// (`return !!(data && data.ok)`), so every distinct failure looked identical
// from the outside and the only way to tell them apart was to guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DECK = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const REGISTRY = readFileSync(new URL('../actions/registry.js', import.meta.url), 'utf8');

const KEYS = [
  'deck_err_title', 'deck_err_not_found', 'deck_err_bad_app_path',
  'deck_err_launch_failed', 'deck_err_blocked_ext', 'deck_err_unavailable',
];
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

test('a failed action reports its reason instead of dropping it', () => {
  const fn = DECK.slice(DECK.indexOf('async function runAction(action)'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /reportActionError\(data && data\.error\)/,
    'the dispatcher reason reaches the reporter');
  // …and the boolean contract is unchanged: callers still gate the red flash on it.
  assert.match(body, /return !!\(data && data\.ok\);/, 'runAction still answers true/false');
});

// Every sentence must correspond to a code the dispatcher can actually return,
// or the table is describing failures that do not exist.
test('every explained code is one the registry emits', () => {
  const table = DECK.slice(DECK.indexOf('const DECK_ERR_TEXT = {'));
  const body = table.slice(0, table.indexOf('\n  };'));
  const codes = [...body.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(codes.length >= 5, 'the table has entries');
  for (const code of codes) {
    // Quoted anywhere in the registry: some are returned literally, others as a
    // fallback (`r.error || 'launch_failed'`), and both are codes it can emit.
    assert.match(REGISTRY, new RegExp("'" + code + "'"), `${code} is a real dispatcher error`);
  }
});

// An unknown code must still reach the screen: it is the thing that gets pasted
// into a report, and swallowing it is what made this invisible in the first place.
test('an unrecognised code is shown rather than swallowed', () => {
  const fn = DECK.slice(DECK.indexOf('function reportActionError(code)'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /const msg = said \? \(code \? said \+ ' \(' \+ code \+ '\)' : said\) : String\(code \|\| ''\);/,
    'no sentence falls back to the bare code, never to nothing');
});

// Sliders post one action per 100ms while dragged. A failing one must not bury
// the screen — but a DIFFERENT failure has to get through immediately.
test('repeats collapse, a new reason does not', () => {
  const fn = DECK.slice(DECK.indexOf('function reportActionError(code)'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /msg === _lastDeckErr\.msg && now - _lastDeckErr\.at < \d+/,
    'the guard is on the message, not on time alone');
});

test('the messages are translated in every language the app ships', () => {
  for (const key of KEYS) {
    const found = new Set();
    let current = null;
    for (const line of I18N.split('\n')) {
      const ns = line.match(/^ {2}"?([a-z]{2})"?: \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
      if (ns) current = ns[1];
      const t = line.trimStart();
      if (t.startsWith(key + ':') || t.startsWith('"' + key + '":')) found.add(current);
    }
    const missing = LANGS.filter((l) => !found.has(l));
    assert.deepEqual(missing, [], `${key} missing from: ${missing.join(', ')}`);
  }
});
