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
import { readFileSync, readdirSync } from 'node:fs';

const DECK = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');
// The sentences moved to their own file, shared with the on-screen alerts.
const ERR_TEXT_SRC = readFileSync(new URL('../js/deck-error-text.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const REGISTRY = readFileSync(new URL('../actions/registry.js', import.meta.url), 'utf8');
// The registry dispatches to provider modules, and a provider names its own
// failures — the registry only passes them through (`r.error || '…_failed'`).
// Voicemeeter was the first entry in the table whose codes live entirely in a
// provider, and this test read the registry alone and called them invented.
const PROVIDERS = readdirSync(new URL('../actions/', import.meta.url))
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(new URL('../actions/' + f, import.meta.url), 'utf8'))
  .join('\n')
  // Capabilities (screenshots, recordings...) answer for themselves too, and
  // the recorder passes on the engine's codes it lets through.
  + readdirSync(new URL('../capabilities/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(new URL('../capabilities/' + f, import.meta.url), 'utf8'))
    .join('\n')
  + readFileSync(new URL('../recorder.js', import.meta.url), 'utf8')
  // Instant Replay answers the replay key's save with its own codes.
  + readFileSync(new URL('../replay.js', import.meta.url), 'utf8')
  // "Clips from marks" answers no_marks / whole_video from the gallery.
  + readFileSync(new URL('../capture-gallery.js', import.meta.url), 'utf8')
  // "Why does it stutter?" answers no_frames / too_soon before it has a reading.
  + readFileSync(new URL('../stutter-why.js', import.meta.url), 'utf8')
  // The power mode key passes on what the OS backend says it cannot do.
  + readdirSync(new URL('../power/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(new URL('../power/' + f, import.meta.url), 'utf8'))
    .join('\n');
// And some registry cases hand their whole job to a dep defined in server.js,
// which names the failure itself: `unknown_device` is the audioDevice dep's
// answer for an output that is not in the live list, and the registry only
// passes it on.
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8')
  // A key run from its keyboard shortcut fails here with its own codes.
  + readFileSync(new URL('../deck-shortcut-runner.js', import.meta.url), 'utf8')
  // …and a sound it plays on the PC itself, with its own two.
  + readFileSync(new URL('../deck-sound-player.js', import.meta.url), 'utf8')
  // The Vitals key passes on Bit's own refill answer (vitals_off, vital_off).
  + readFileSync(new URL('../vitals-ai-tools.js', import.meta.url), 'utf8');

const KEYS = [
  'deck_err_title', 'deck_err_not_found', 'deck_err_bad_app_path',
  'deck_err_launch_failed', 'deck_err_blocked_ext', 'deck_err_unavailable',
  // Voicemeeter: every one of these is something the person at the machine can
  // fix, which is the bar for getting a sentence rather than a raw code.
  'deck_err_vm_not_installed', 'deck_err_vm_not_running', 'deck_err_vm_windows_only',
  'deck_err_vm_unavailable', 'deck_err_vm_bad_strip', 'deck_err_vm_bad_bus',
  'deck_err_vm_bad_param', 'deck_err_vm_bad_macro', 'deck_err_vm_bad_value',
  // Screenshot and recording keys.
  'deck_err_no_window', 'deck_err_no_encoder', 'deck_err_disk_full',
  'deck_err_no_frames', 'deck_err_too_soon',
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
  const table = ERR_TEXT_SRC.slice(ERR_TEXT_SRC.indexOf('const DECK_ERR_TEXT = Object.freeze({'));
  const body = table.slice(0, table.indexOf('\n  });'));
  const codes = [...body.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(codes.length >= 5, 'the table has entries');
  for (const code of codes) {
    // Quoted anywhere in the registry: some are returned literally, others as a
    // fallback (`r.error || 'launch_failed'`), and both are codes it can emit.
    // deck.js may raise one itself before posting (a key still to set up).
    const quoted = new RegExp("'" + code + "'");
    const raisedHere = DECK.includes("reportActionError('" + code + "')");
    assert.ok(quoted.test(REGISTRY) || quoted.test(PROVIDERS) || quoted.test(SERVER) || raisedHere,
      `${code} is explained on screen but no dispatcher or provider emits it`);
  }
});

// An unknown code must still reach the screen: it is the thing that gets pasted
// into a report, and swallowing it is what made this invisible in the first place.
test('an unrecognised code is shown rather than swallowed', async () => {
  const { describe, shortcutFailed } = (await import('../js/deck-error-text.js')).default;
  const tt = (_key, fallback) => fallback;
  assert.equal(describe('weird_code', tt), 'weird_code', 'no sentence falls back to the bare code, never to nothing');
  assert.equal(describe('not_found', tt), 'that path does not exist on this PC (not_found)');
  assert.equal(describe('already_small', tt), 'It is already smaller than that: send it as it is (already_small)', 'an export key says why');
  assert.equal(describe('', tt), '');
  assert.equal(describe('__proto__', tt), '__proto__', 'only own entries count');
  // deck.js goes through the shared describer for both toasts.
  const fn = DECK.slice(DECK.indexOf('function reportActionError(code)'));
  assert.match(fn.slice(0, fn.indexOf('\n  }')), /const msg = describeDeckError\(code\);/);
  assert.match(DECK, /DeckErrorText\.shortcutFailed\(info, tt\)/);
  const t = shortcutFailed({ error: 'no_dashboard', title: 'x'.repeat(80) }, tt);
  assert.equal(t.type, 'error');
  assert.ok(t.title.endsWith(': ' + 'x'.repeat(60)), 'the key name is capped');
  assert.match(t.message, /\(no_dashboard\)$/);
});

test('every page that loads deck.js loads the sentences first', () => {
  for (const page of ['index.html', 'deck-popup.html']) {
    const html = readFileSync(new URL('../' + page, import.meta.url), 'utf8');
    const a = html.indexOf('js/deck-error-text.js'), b = html.indexOf('js/deck.js"');
    assert.ok(a > 0 && a < b, page);
  }
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
