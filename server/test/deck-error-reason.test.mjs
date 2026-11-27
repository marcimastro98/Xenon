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
import { readdirSync } from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import { appStringsSource } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const DECK = readFileSync(new URL('../js/deck/deck.js', import.meta.url), 'utf8');
// The sentences moved to their own file, shared with the on-screen alerts.
const ERR_TEXT_SRC = readFileSync(new URL('../js/deck/deck-error-text.js', import.meta.url), 'utf8');
const I18N = appStringsSource();
const REGISTRY = engineSource('server/actions/registry.js');
// The page rules answer the menu and the Deck with their own codes.
const LAYER_PAGES = readFileSync(new URL('../layers/layer-pages.js', import.meta.url), 'utf8');
// Opening iCUE with the pump widget answers the menu with its own codes.
const PUMP_ICUE = readFileSync(new URL('../pump-screen/icue.js', import.meta.url), 'utf8');
const AIRFLOW = readFileSync(new URL('../airflow/actions.js', import.meta.url), 'utf8');
const HOME_CAMERA = readFileSync(new URL('../smart-home/camera-show.js', import.meta.url), 'utf8');
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
  + readFileSync(new URL('../screens/recorder.js', import.meta.url), 'utf8')
  // Instant Replay answers the replay key's save with its own codes.
  + readFileSync(new URL('../screens/replay.js', import.meta.url), 'utf8')
  // "Clips from marks" answers no_marks / whole_video from the gallery.
  + readFileSync(new URL('../screens/capture-gallery.js', import.meta.url), 'utf8')
  // "Why does it stutter?" answers no_frames / too_soon before it has a reading.
  + readFileSync(new URL('../performance/stutter-why.js', import.meta.url), 'utf8')
  // A steps recording stopped before any click answers no_steps.
  + readFileSync(new URL('../screens/steps-recorder.js', import.meta.url), 'utf8')
  // The power mode key passes on what the OS backend says it cannot do.
  + readdirSync(new URL('../power/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(new URL('../power/' + f, import.meta.url), 'utf8'))
    .join('\n');
// And some registry cases hand their whole job to a dep defined in server.js,
// which names the failure itself: `unknown_device` is the audioDevice dep's
// answer for an output that is not in the live list, and the registry only
// passes it on.
const SERVER = engineSource()
  // What a paired phone may run (needs_pc, pc_only).
  + readFileSync(new URL('../paired/remote-actions.js', import.meta.url), 'utf8')
  // A key run from its keyboard shortcut fails here with its own codes.
  + readFileSync(new URL('../deck/deck-shortcut-runner.js', import.meta.url), 'utf8')
  // …and a sound it plays on the PC itself, with its own two.
  + readFileSync(new URL('../deck/deck-sound-player.js', import.meta.url), 'utf8')
  // The Vitals key passes on Bit's own refill answer (vitals_off, vital_off).
  + readFileSync(new URL('../vitals/vitals-ai-tools.js', import.meta.url), 'utf8')
  // A notification whose app cannot be started from it (not_launchable).
  + readFileSync(new URL('../notification-open/index.js', import.meta.url), 'utf8');

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
  'deck_err_over_exclusive', 'deck_err_no_frames', 'deck_err_too_soon', 'deck_err_no_game', 'deck_err_no_pages', 'deck_err_no_widgets', 'deck_err_save_failed',
  // Wave Link (actions/wavelink.js): the ones a person can act on.
  'deck_err_wl_off', 'deck_err_wl_unreachable', 'deck_err_wl_channel', 'deck_err_wl_mix', 'deck_err_wl_not_in_mix',
  'deck_err_wl_effect', 'deck_err_wl_unsupported',
  // The other apps a key talks to, and the states a key can only report.
  'deck_err_obs_unreachable', 'deck_err_sb_unreachable', 'deck_err_ha_not_set_up', 'deck_err_ha_auth', 'deck_err_ha_unreachable',
  'deck_err_chroma_unreachable', 'deck_err_nothing_running', 'deck_err_already_recording', 'deck_err_no_second_screen', 'deck_err_nothing_to_undo',
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
    assert.ok(quoted.test(REGISTRY) || quoted.test(PROVIDERS) || quoted.test(SERVER) || quoted.test(LAYER_PAGES) || quoted.test(PUMP_ICUE) || quoted.test(AIRFLOW) || quoted.test(HOME_CAMERA) || raisedHere,
      `${code} is explained on screen but no dispatcher or provider emits it`);
  }
});

// An unknown code must still reach the screen: it is the thing that gets pasted
// into a report, and swallowing it is what made this invisible in the first place.
test('an unrecognised code is shown rather than swallowed', async () => {
  const { describe, shortcutFailed } = (await import('../js/deck/deck-error-text.js')).default;
  const tt = (_key, fallback) => fallback;
  assert.equal(describe('weird_code', tt), 'weird_code', 'no sentence falls back to the bare code, never to nothing');
  assert.equal(describe('not_found', tt), 'That path does not exist on this PC', 'a sentence stands alone and starts as one');
  assert.equal(describe('already_small', tt), 'It is already smaller than that: send it as it is', 'an export key says why');
  assert.equal(describe('', tt), '');
  assert.equal(describe('__proto__', tt), '__proto__', 'only own entries count');
  // deck.js goes through the shared describer for both toasts.
  const fn = DECK.slice(DECK.indexOf('function reportActionError(code)'));
  assert.match(fn.slice(0, fn.indexOf('\n  }')), /const msg = describeDeckError\(code\);/);
  assert.match(DECK, /DeckErrorText\.shortcutFailed\(info, tt\)/);
  const t = shortcutFailed({ error: 'no_dashboard', title: 'x'.repeat(80) }, tt);
  assert.equal(t.type, 'error');
  assert.ok(t.title.endsWith(': ' + 'x'.repeat(60)), 'the key name is capped');
  assert.equal(t.message, 'This step needs the Xenon dashboard open on this PC');
});

// Found by pressing every new key: the sentence for a replay key was the answer
// to a benchmark key too, and two ordinary answers had no sentence at all.
test('the sentence fits every key that can get the code', async () => {
  const { describe } = (await import('../js/deck/deck-error-text.js')).default;
  const tt = (_key, fallback) => fallback;
  assert.equal(describe('no_game', tt), 'Open a game first', 'benchmark, replay and frame reads all answer no_game');
  assert.equal(describe('no_steps', tt), 'No clicks, nothing saved');
  assert.equal(describe('save_failed', tt), 'The clip could not be saved, try again', 'a raw code under the red title says nothing');
  assert.match(describe('no_pages', tt), /only one widget page/);
  assert.match(describe('no_widgets', tt), /no widgets yet/);
  assert.match(describe('unknown_page', tt), /no such page/);
});

// "This key could not run" over "open a game first" reads as a broken key.
// A Discord report: a Wave Link key toasted the bare code "wl_disabled".
test('Wave Link says why in a sentence; the codes only a report can use stay codes', async () => {
  const { describe, keyToast } = (await import('../js/deck/deck-error-text.js')).default;
  const tt = (_key, fallback) => fallback;
  const off = describe('wl_disabled', tt);
  assert.match(off, /^Wave Link is off in Xenon/);
  assert.equal(keyToast('wl_disabled', off, tt).type, 'info', 'a switch left off is a note, not a failure');
  for (const code of ['wl_not_found', 'wl_connect_failed', 'wl_probe_timeout', 'wl_probe_failed', 'wl_closed', 'wl_request_timeout']) {
    assert.match(describe(code, tt), /cannot reach Wave Link/, code);
  }
  for (const code of ['wl_unknown_channel', 'wl_unknown_mix', 'wl_channel_not_in_mix', 'wl_unknown_effect', 'wl_unsupported']) {
    assert.notEqual(describe(code, tt), code, code);
    assert.equal(keyToast(code, 'x', tt).type, 'error', code);
  }
  assert.equal(describe('wl_unknown_device', tt), 'That output device is not connected right now');
  for (const code of ['wl_wrong_app', 'wl_no_origin', 'wl_no_appinfo', 'wl_request_failed', 'wl_config_failed', 'wl_failed']) {
    assert.equal(describe(code, tt), code, code + ' stays a code for the report');
  }
});

test('a key that cannot reach its app, or has nothing to work on, says so in a sentence', async () => {
  const { describe, keyToast } = (await import('../js/deck/deck-error-text.js')).default;
  const tt = (_key, fallback) => fallback;
  const groups = {
    'cannot reach OBS': ['obs_connect_failed', 'obs_closed', 'obs_timeout', 'obs_request_timeout'],
    'cannot reach Streamer.bot': ['sb_connect_failed', 'sb_closed', 'sb_timeout', 'sb_request_timeout'],
    'cannot reach Home Assistant': ['ha_connect_failed', 'ha_closed', 'ha_timeout', 'ha_request_timeout'],
    'not set up yet: pick': ['empty_path', 'empty_text', 'empty_message', 'empty_prompt', 'empty_id', 'empty_effect'],
  };
  for (const [said, codes] of Object.entries(groups)) for (const code of codes) assert.match(describe(code, tt), new RegExp(said), code);
  assert.match(describe('ha_not_configured', tt), /Settings, Smart Home/);
  assert.match(describe('ha_auth_invalid', tt), /token/);
  assert.match(describe('chroma_init_failed', tt), /Razer/);
  for (const code of ['nothing_running', 'running', 'no_second_screen', 'nothing_to_undo']) {
    assert.notEqual(describe(code, tt), code, code);
    assert.equal(keyToast(code, 'x', tt).type, 'info', code + ': nothing is broken');
  }
  // Wiring that only a broken build can miss stays a code for the report.
  for (const code of ['obs_unavailable', 'chroma_unavailable', 'obs_config_failed', 'bad_args', 'ambiguous']) assert.equal(describe(code, tt), code, code);
});

test('a normal situation is a note, a real failure stays an error', async () => {
  const { keyToast } = (await import('../js/deck/deck-error-text.js')).default;
  const tt = (_key, fallback) => fallback;
  for (const code of ['no_game', 'no_file', 'no_frames', 'not_recording', 'no_marks', 'whole_video', 'no_steps', 'no_pages', 'no_widgets', 'no_phone', 'companion_off']) {
    const note = keyToast(code, 'Open a game first', tt);
    assert.equal(note.type, 'info', code);
    assert.equal(note.title, 'Open a game first', code);
    assert.equal(note.message, undefined, code);
    assert.equal(note.important, true, code + ': a key just pressed answers even under Do not disturb');
  }
  for (const code of ['launch_failed', 'disk_full', 'write_failed', 'weird_code']) {
    const bad = keyToast(code, 'why', tt);
    assert.equal(bad.type, 'error', code);
    assert.equal(bad.title, 'This key could not run', code);
    assert.equal(bad.message, 'why', code);
  }
});

test('a stopped steps recording is told once on a page with the capture cards', () => {
  const fn = DECK.slice(DECK.indexOf('function reportActionError(code)'));
  assert.match(fn.slice(0, fn.indexOf('\n  }')), /code === 'no_steps' && window\.CaptureToast/);
});

test('every page that loads deck.js loads the sentences first', () => {
  for (const page of ['index.html', 'deck-popup.html']) {
    const html = readFileSync(new URL('../' + page, import.meta.url), 'utf8');
    const a = html.indexOf('js/deck/deck-error-text.js'), b = html.indexOf('js/deck/deck.js"');
    assert.ok(a > 0 && a < b, page);
    const c = html.indexOf('js/deck/deck-done-text.js');
    assert.ok(c > 0 && c < b, page + ' loads the done notes too');
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
