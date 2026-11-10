// "I installed Xenon yesterday and everything worked. After shutting down and
// rebooting, Xenon wants to install again and will not load" (Discord, Oct 2026).
//
// The engine was installed and its startup task was on; it just was not
// answering yet (or failed to start). The splash fell through to its install
// panel after 20 s, the setup found everything in place and said "already
// installed, restart your PC", and the restart led straight back. These tests
// run the splash's REAL script against a fake DOM and a fake clock, so the
// panel a user would see is what is asserted, not the shape of the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../../apps/native/splash/index.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const SCRIPT = (() => {
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, 'the splash has no inline script');
  return scripts[scripts.length - 1][1];
})();

const WORDS = readFileSync(new URL('../../apps/native/splash/words.js', import.meta.url), 'utf8');

function fakeElement(text = '') {
  const classes = new Set();
  const el = {
    textContent: text,
    disabled: false,
    hidden: false,
    style: {},
    attrs: {},
    setAttribute(name, value) { el.attrs[name] = value; },
    listeners: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    addEventListener(type, fn) { el.listeners[type] = fn; },
  };
  return el;
}

// Boots the splash with the given shell flags. `answers` decides whether the
// engine is up; flip it later to bring the engine up mid-run.
function bootSplash({ flags = {}, setupAvailable = true, language = 'en-US' } = {}) {
  let now = 0;
  const timers = [];
  const els = {
    status: fakeElement(),
    hint: fakeElement(),
    setup: fakeElement(),
    'setup-title': fakeElement("Xenon isn't finished installing"),
    'setup-body': fakeElement('One part of Xenon is still missing on this PC.'),
    'setup-btn': fakeElement('Complete setup'),
    'setup-note': fakeElement('Already installed? Wait a few seconds.'),
    wrap: fakeElement(),
    progress: fakeElement(),
    'progress-fill': fakeElement(),
  };
  const state = { answers: false, navigatedTo: '' };
  const location = {
    href: '',
    replace(url) { state.navigatedTo = url; },
  };
  const window = { __XENON_SETUP_AVAILABLE__: setupAvailable, location, ...flags };
  const context = {
    window,
    document: { getElementById: (id) => els[id], documentElement: {} },
    navigator: { platform: 'Win32', language },
    Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.push({ at: now + ms, fn }); },
    setInterval: (fn, ms) => {
      const handle = { cancelled: false };
      const tick = () => {
        if (handle.cancelled) return;
        fn();
        timers.push({ at: now + ms, fn: tick });
      };
      timers.push({ at: now + ms, fn: tick });
      return handle;
    },
    clearInterval: (handle) => { if (handle) handle.cancelled = true; },
    fetch: () => (state.answers ? Promise.resolve({}) : Promise.reject(new TypeError('refused'))),
  };
  vm.runInNewContext(WORDS + SCRIPT, context);

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  async function advanceTo(ms) {
    await flush();
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > ms) break;
      const next = timers.shift();
      now = next.at;
      next.fn();
      await flush();
    }
    now = ms;
  }
  const panel = () => ({
    shown: els.setup.classList.contains('show'),
    title: els['setup-title'].textContent,
    body: els['setup-body'].textContent,
    button: els['setup-btn'].textContent,
    disabled: els['setup-btn'].disabled,
    buttonHidden: els['setup-btn'].hidden,
    note: els['setup-note'].textContent,
    bar: els.progress.classList.contains('show') ? els['progress-fill'].style.width : '',
  });
  const click = () => els['setup-btn'].listeners.click();
  return { window, els, state, advanceTo, panel, click, now: () => now };
}

test('an installed engine that stays silent is never offered an install', async () => {
  const s = bootSplash({ flags: { __XENON_BACKEND_INSTALLED__: true } });
  await s.advanceTo(21000);
  // Past the old 20 s threshold: the install panel used to be up by now.
  assert.equal(s.panel().shown, false);

  await s.advanceTo(26000);
  const p = s.panel();
  assert.equal(p.shown, true);
  assert.equal(p.title, 'Xenon has not started yet');
  assert.equal(p.button, 'Start Xenon');
  assert.doesNotMatch(p.title + p.body, /finished installing|missing on this PC/);
});

test('"Start Xenon" asks the shell to start the task, then offers the repair', async () => {
  const s = bootSplash({ flags: { __XENON_BACKEND_INSTALLED__: true } });
  await s.advanceTo(26000);
  s.click();
  assert.equal(s.window.location.href, 'xenon-setup:start');
  assert.equal(s.panel().disabled, true);

  // Still silent half a minute after the start: the repair, never "setup again".
  await s.advanceTo(26000 + 31000);
  const p = s.panel();
  assert.equal(p.title, 'Xenon did not start');
  assert.equal(p.button, 'Repair Xenon');
  assert.equal(p.disabled, false);
  assert.match(p.body, /settings, layouts and notes are kept/);

  s.click();
  assert.equal(s.window.location.href, 'xenon-setup:run');
  // And a repair that still produces nothing hands its own button back.
  await s.advanceTo(26000 + 31000 + 31000);
  assert.equal(s.panel().button, 'Run repair again');
  assert.equal(s.panel().disabled, false);
});

test('a start the shell could not even launch goes to the repair at once', async () => {
  const s = bootSplash({ flags: { __XENON_BACKEND_INSTALLED__: true } });
  await s.advanceTo(26000);
  s.click();
  s.window.__XENON_START_FAILED__ = true;
  await s.advanceTo(27000);
  assert.equal(s.panel().title, 'Xenon did not start');
});

test('the shell\'s answer replaces an install panel nobody acted on yet', async () => {
  // The flag is pushed repeatedly but can still land late; the page must not
  // stay on the wrong panel once it knows.
  const s = bootSplash();
  await s.advanceTo(21000);
  assert.equal(s.panel().title, "Xenon isn't finished installing");
  s.window.__XENON_BACKEND_INSTALLED__ = true;
  await s.advanceTo(26000);
  assert.equal(s.panel().title, 'Xenon has not started yet');
});

test('a PC with no engine at all still gets the install panel', async () => {
  const s = bootSplash({ flags: { __XENON_BACKEND_ABSENT__: true } });
  await s.advanceTo(1000);
  assert.equal(s.panel().shown, true);
  assert.equal(s.panel().title, "Xenon isn't finished installing");
  s.click();
  assert.equal(s.window.location.href, 'xenon-setup:run');
});

test('a switched-off task still gets the switch, not the start', async () => {
  const s = bootSplash({ flags: { __XENON_TASK_DISABLED__: true } });
  await s.advanceTo(30000);
  assert.equal(s.panel().title, 'Xenon is set not to start');
  s.click();
  assert.equal(s.window.location.href, 'xenon-setup:enable-task');
});

test('the dashboard opens the moment the engine answers, whatever panel is up', async () => {
  const s = bootSplash({ flags: { __XENON_BACKEND_INSTALLED__: true } });
  await s.advanceTo(26000);
  s.state.answers = true;
  await s.advanceTo(30000);
  assert.equal(s.state.navigatedTo, 'http://127.0.0.1:3030/?shell=main');
});

test('a build without the bootstrap gives the start back instead of a repair', async () => {
  const s = bootSplash({ flags: { __XENON_BACKEND_INSTALLED__: true }, setupAvailable: false });
  await s.advanceTo(26000);
  s.click();
  await s.advanceTo(26000 + 31000);
  assert.equal(s.panel().button, 'Try again');
  assert.equal(s.panel().disabled, false);
  s.click();
  assert.equal(s.window.location.href, 'xenon-setup:start');
});

test('the splash speaks the language the dashboard left, then the system\'s', () => {
  const said = (opts) => bootSplash(opts).panel().button;
  assert.equal(said({ flags: { __XENON_NATIVE_CAPS__: { splashLang: 'it' } }, language: 'de-DE' }), 'Completa la configurazione');
  assert.equal(said({ language: 'it-IT' }), 'Completa la configurazione');
  assert.equal(said({ flags: { __XENON_NATIVE_CAPS__: { splashLang: '' } }, language: 'fr-FR' }), 'Terminer la configuration');
  assert.equal(said({ flags: { __XENON_NATIVE_CAPS__: { splashLang: 'xx' } }, language: 'zz' }), 'Complete setup');
});

test('every language has every word, and the installer slot', () => {
  const box = { window: {} };
  vm.runInNewContext(WORDS, box);
  const all = box.window.SPLASH_WORDS;
  assert.deepEqual(Object.keys(all).sort(), ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']);
  const keys = Object.keys(all.en).sort();
  for (const [code, words] of Object.entries(all)) {
    assert.deepEqual(Object.keys(words).sort(), keys, code);
    assert.match(words.stuck, /\{installer\}/, code);
    for (const text of Object.values(words)) assert.doesNotMatch(text, /—|–/, code + ': ' + text.slice(0, 50));
  }
});

test('the dashboard tells the shell a new language once, and an older shell never', () => {
  const bridge = readFileSync(new URL('../js/native-bridge.js', import.meta.url), 'utf8');
  const start = bridge.indexOf('function tellSplashLanguage');
  const source = bridge.slice(start, bridge.indexOf('// Restart the app', start));
  const tell = (caps) => {
    const window = { __XENON_NATIVE_CAPS__: caps, location: { href: '' }, __xenonSignal: (url) => url + '&xn=1' };
    const sent = [];
    Object.defineProperty(window.location, 'href', { set: (url) => sent.push(url) });
    const run = vm.runInNewContext('(' + source + ')', { window, isNative: true, afterLoad: (fn) => fn(), encodeURIComponent });
    return { run, sent };
  };
  const fresh = tell({ splashLang: '' });
  fresh.run('it');
  fresh.run('it');
  assert.deepEqual(fresh.sent, ['xenon-app:splash-language?l=it&xn=1']);
  const same = tell({ splashLang: 'it' });
  same.run('it');
  assert.deepEqual(same.sent, []);
  const older = tell({});
  older.run('it');
  assert.deepEqual(older.sent, []);
});

test('a normal start says nothing, a slow one says it is waiting', async () => {
  const fast = bootSplash();
  fast.state.answers = true;
  await fast.advanceTo(2000);
  assert.ok(fast.state.navigatedTo.includes('/?shell=main'));
  assert.equal(fast.els.status.textContent, '');
  const slow = bootSplash();
  await slow.advanceTo(2000);
  assert.equal(slow.els.status.textContent, '');
  await slow.advanceTo(4000);
  assert.equal(slow.els.status.textContent, 'Waiting for Xenon to start…');
});

// 5.1.0: the setup carries the engine and the shell installs it itself
// (engine_install in src-tauri), reporting {step, percent, failed, done}.
const BUNDLED = { __XENON_ENGINE_BUNDLED__: true, __XENON_BACKEND_ABSENT__: true };

test('a build that carries the engine shows the shell\'s progress, not the console offer', async () => {
  const s = bootSplash({ flags: BUNDLED });
  await s.advanceTo(1000);
  // The shell is already installing: no "complete setup" button meanwhile.
  assert.equal(s.panel().shown, false);
  s.window.__XENON_INSTALL__ = { step: 'copying', percent: 40, failed: false, done: false };
  await s.advanceTo(1500);
  const p = s.panel();
  assert.equal(p.title, 'Setting up Xenon');
  assert.equal(p.body, 'Copying Xenon to this computer…');
  assert.equal(p.bar, '40%');
  assert.equal(p.buttonHidden, true);
  assert.doesNotMatch(p.body + p.note, /window|console/i);
  // Twenty seconds in, still installing: the old offer must not cover it.
  await s.advanceTo(25000);
  assert.equal(s.panel().title, 'Setting up Xenon');
  s.window.__XENON_INSTALL__ = { step: 'ready', percent: 100, failed: false, done: true };
  s.state.answers = true;
  await s.advanceTo(28000);
  assert.ok(s.state.navigatedTo.includes('/?shell=main'));
});

test('a failed install says so, names the log and runs again on Try again', async () => {
  const s = bootSplash({ flags: BUNDLED });
  s.window.__XENON_INSTALL__ = { step: 'copy', percent: 0, failed: true, done: true };
  await s.advanceTo(1000);
  let p = s.panel();
  assert.match(p.body, /stopped before the end/);
  assert.ok(p.note.includes('%APPDATA%\\com.marcimastro98.xenon\\crash.log'), p.note);
  assert.equal(p.button, 'Try again');
  assert.equal(p.buttonHidden, false);
  assert.equal(p.bar, '');
  s.click();
  assert.equal(s.window.location.href, 'xenon-setup:run');
  p = s.panel();
  assert.equal(p.body, 'Getting ready…');
  assert.equal(p.buttonHidden, true);
  // A rearm timer must never talk over the shell's own install.
  await s.advanceTo(40000);
  assert.equal(s.panel().title, 'Setting up Xenon');
});

test('an engine that installed but never answered gets its own words', async () => {
  const s = bootSplash({ flags: BUNDLED });
  s.window.__XENON_INSTALL__ = { step: 'no_answer', percent: 0, failed: true, done: true };
  await s.advanceTo(1000);
  assert.match(s.panel().body, /set up but has not started yet/);
});

test('the bundled offer, if the shell never reported, installs right here', async () => {
  const s = bootSplash({ flags: { __XENON_ENGINE_BUNDLED__: true } });
  await s.advanceTo(21000);
  assert.match(s.panel().body, /adds it right here/);
  s.click();
  assert.equal(s.window.location.href, 'xenon-setup:run');
  assert.equal(s.panel().title, 'Setting up Xenon');
});

test('the old console flow never says "still not started" while its window is open', async () => {
  const s = bootSplash({ flags: { __XENON_BACKEND_ABSENT__: true } });
  await s.advanceTo(1000);
  s.click();
  s.window.__XENON_SETUP_RUNNING__ = true;
  await s.advanceTo(1000 + 45000);
  assert.equal(s.panel().disabled, true);
  assert.doesNotMatch(s.panel().body, /still not started/);
  s.window.__XENON_SETUP_RUNNING__ = false;
  await s.advanceTo(1000 + 46000);
  assert.equal(s.panel().button, 'Run setup again');
});
