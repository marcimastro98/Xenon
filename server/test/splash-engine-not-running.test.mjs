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

function fakeElement(text = '') {
  const classes = new Set();
  const el = {
    textContent: text,
    disabled: false,
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
function bootSplash({ flags = {}, setupAvailable = true } = {}) {
  let now = 0;
  const timers = [];
  const els = {
    status: fakeElement('Starting Xenon…'),
    hint: fakeElement(),
    setup: fakeElement(),
    'setup-title': fakeElement("Xenon isn't finished installing"),
    'setup-body': fakeElement('One part of Xenon is still missing on this PC.'),
    'setup-btn': fakeElement('Complete setup'),
    'setup-note': fakeElement('Already installed? Wait a few seconds.'),
    wrap: fakeElement(),
  };
  const state = { answers: false, navigatedTo: '' };
  const location = {
    href: '',
    replace(url) { state.navigatedTo = url; },
  };
  const window = { __XENON_SETUP_AVAILABLE__: setupAvailable, location, ...flags };
  const context = {
    window,
    document: { getElementById: (id) => els[id] },
    navigator: { platform: 'Win32' },
    Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.push({ at: now + ms, fn }); },
    fetch: () => (state.answers ? Promise.resolve({}) : Promise.reject(new TypeError('refused'))),
  };
  vm.runInNewContext(SCRIPT, context);

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
  });
  const click = () => els['setup-btn'].listeners.click();
  return { window, state, advanceTo, panel, click, now: () => now };
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
