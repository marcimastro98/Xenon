// The Linux global shortcut. Everything here writes to the user's own keyboard
// settings, so the two things pinned hardest are: an accelerator GNOME can
// actually parse, and a registration that never leaves a half-written entry
// behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  createLinuxHotkey, toAccelerator, normalizeAccel, bindingsFrom, parsePathArray, commandFor,
  KEY_PATH, SCHEMA,
} = require(join(ROOT, 'linux-hotkey.js'));

test('a combo becomes a GNOME accelerator', () => {
  assert.equal(toAccelerator('alt+space'), '<Alt>space');
  assert.equal(toAccelerator('ctrl+shift+f'), '<Control><Shift>f');
  assert.equal(toAccelerator('super+k'), '<Super>k');
  assert.equal(toAccelerator('ctrl+alt+f5'), '<Control><Alt>F5');
  assert.equal(toAccelerator('ctrl+enter'), '<Control>Return');
});

test('modifiers are emitted in GNOME\'s canonical order whatever order they are typed', () => {
  // Conflict detection compares accelerator STRINGS against what GNOME stored,
  // so "<Shift><Control>f" and "<Control><Shift>f" being different strings for
  // the same shortcut would make a real clash invisible.
  assert.equal(toAccelerator('shift+ctrl+f'), '<Control><Shift>f');
  assert.equal(toAccelerator('super+alt+j'), '<Alt><Super>j');
});

test('a bare key with no modifier is refused', () => {
  // Binding "f" desktop-wide would take that letter away from every application
  // the user has open.
  assert.equal(toAccelerator('f'), null);
  assert.equal(toAccelerator('space'), null);
});

test('an unparsable combo is refused rather than guessed', () => {
  // GNOME stores an accelerator it cannot parse without complaint and then
  // never fires it — a shortcut that reports "listening" and does nothing.
  assert.equal(toAccelerator('ctrl+nonsensekey'), null);
  assert.equal(toAccelerator('ctrl+a+b'), null);
  assert.equal(toAccelerator('ctrl'), null);
  assert.equal(toAccelerator(''), null);
  assert.equal(toAccelerator('ctrl+f25'), null);
});

test('existing bindings are read out of gsettings output', () => {
  const raw = [
    "org.gnome.desktop.wm.keybindings close ['<Alt>F4', '<Super>q']",
    "org.gnome.desktop.wm.keybindings begin-move @as []",
    "org.gnome.shell.keybindings toggle-overview ['<Super>s']",
  ].join('\n');
  assert.deepEqual(bindingsFrom(raw), ['<Alt>F4', '<Super>q', '<Super>s']);
});

test('the custom-keybindings path array is parsed, including the empty form', () => {
  assert.deepEqual(parsePathArray('@as []'), []);
  assert.deepEqual(parsePathArray(''), []);
  assert.deepEqual(
    parsePathArray("['/org/gnome/a/custom0/', '/org/gnome/a/custom1/']"),
    ['/org/gnome/a/custom0/', '/org/gnome/a/custom1/']);
});

test('the shortcut command falls back through curl, wget, then bare bash', () => {
  assert.match(commandFor(3030, { curl: '/usr/bin/curl' }), /^\/usr\/bin\/curl .*-X POST http:\/\/127\.0\.0\.1:3030\/search\/hotkey-press$/);
  assert.match(commandFor(3030, { wget: '/usr/bin/wget' }), /^\/usr\/bin\/wget /);
  // Nothing installed at all still has to work: /dev/tcp is built into bash and
  // needs no package.
  assert.match(commandFor(3030, {}), /\/dev\/tcp\/127\.0\.0\.1\/3030/);
});

// A gsettings stand-in that records every call and answers the reads.
function fakeGsettings(state = {}) {
  const calls = [];
  const schemas = state.schemas ?? ['org.gnome.desktop.wm.keybindings', SCHEMA];
  const store = new Map(Object.entries(state.values || {}));
  const runner = async (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'list-schemas') return schemas.join('\n');
    if (args[0] === 'list-recursively') return state.recursive?.[args[1]] ?? '';
    if (args[0] === 'get') return store.get(`${args[1]} ${args[2]}`) ?? '@as []';
    if (args[0] === 'set') { store.set(`${args[1]} ${args[2]}`, args[3]); return ''; }
    if (args[0] === 'reset') { store.delete(`${args[1]} ${args[2]}`); return ''; }
    return '';
  };
  return { calls, runner, store };
}

const lookup = (bin) => (bin === 'gsettings' ? '/usr/bin/gsettings' : bin === 'curl' ? '/usr/bin/curl' : null);

test('registering writes name, command and binding, and adds the path last', async () => {
  const g = fakeGsettings();
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  const r = await hk.register('alt+space');
  assert.equal(r.ok, true);
  assert.equal(r.state, 'listening');
  assert.equal(r.accelerator, '<Alt>space');

  const setCalls = g.calls.filter((c) => c.startsWith('set '));
  const pathIdx = setCalls.findIndex((c) => c.includes('custom-keybindings ['));
  const bindingIdx = setCalls.findIndex((c) => c.includes(' binding '));
  // gnome-settings-daemon reads the entry the moment the path list changes; add
  // the path first and it binds a shortcut whose command is not written yet.
  assert.ok(bindingIdx >= 0 && pathIdx > bindingIdx, setCalls.join('\n'));
  assert.equal(g.store.get(`org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${KEY_PATH} binding`), '<Alt>space');
});

test('a combo another shortcut already owns is reported as taken, and nothing is written', async () => {
  const g = fakeGsettings({
    recursive: { 'org.gnome.desktop.wm.keybindings': "org.gnome.desktop.wm.keybindings cycle ['<Alt>space']" },
  });
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  const r = await hk.register('alt+space');
  assert.equal(r.ok, false);
  assert.equal(r.state, 'taken');
  // Silently overwriting is what GNOME itself does, and the result is a
  // shortcut that never fires with no explanation anywhere.
  assert.equal(g.calls.some((c) => c.startsWith('set ')), false);
});

test('normalizeAccel: equivalent spellings collapse, unknown modifiers do not', () => {
  const want = normalizeAccel('<Control><Alt>s');
  for (const spelling of ['<Alt><Control>s', '<Primary><Alt>s', '<Ctrl><Alt>S', '<Alt><Primary>S', '<Mod1><Control>s']) {
    assert.equal(normalizeAccel(spelling), want, spelling);
  }
  assert.notEqual(normalizeAccel('<Control><Shift>s'), want);
  // Unparseable input normalises to '' and can therefore never collide with a
  // real binding — an unknown modifier is not ours to guess at.
  assert.equal(normalizeAccel('<Level3>s'), '');
  assert.equal(normalizeAccel('s'), '');           // no modifier
  assert.equal(normalizeAccel('<Control>'), '');   // no key
  assert.equal(normalizeAccel(''), '');
});

test('a conflict spelled differently is still a conflict', async () => {
  // GNOME accepts <Primary>, <Ctrl>, <Mod1>/<Mod4> and any modifier ORDER, and
  // resolves a duplicate binding by firing NEITHER shortcut. Comparing raw
  // strings missed most two-modifier clashes, so registration reported
  // 'listening' and the hotkey silently never worked.
  for (const existing of ['<Alt><Control>s', '<Primary><Alt>s', '<Ctrl><Alt>S']) {
    const g = fakeGsettings({
      recursive: { 'org.gnome.desktop.wm.keybindings': `org.gnome.desktop.wm.keybindings cycle ['${existing}']` },
    });
    const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
    const r = await hk.register('ctrl+alt+s');
    assert.equal(r.state, 'taken', existing);
    assert.equal(g.calls.some((c) => c.startsWith('set ')), false, existing);
  }
  // A genuinely different combo still registers.
  const g = fakeGsettings({
    recursive: { 'org.gnome.desktop.wm.keybindings': "org.gnome.desktop.wm.keybindings cycle ['<Alt><Control>s']" },
  });
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  assert.equal((await hk.register('ctrl+shift+s')).ok, true);
});

test('our own previous registration is not a conflict with itself', async () => {
  const g = fakeGsettings({
    values: { [`${SCHEMA} custom-keybindings`]: `['${KEY_PATH}']` },
  });
  g.store.set(`org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${KEY_PATH} binding`, "'<Alt>space'");
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  // Re-saving the same combo must succeed, or Settings reports 'taken' against
  // Xenon's own shortcut every time the user touches that page.
  assert.equal((await hk.register('alt+space')).ok, true);
});

test('unregistering removes the path and resets the entry', async () => {
  const g = fakeGsettings({
    values: { [`${SCHEMA} custom-keybindings`]: `['/other/custom0/', '${KEY_PATH}']` },
  });
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  await hk.unregister();
  assert.equal(g.store.get(`${SCHEMA} custom-keybindings`), "['/other/custom0/']");
  // Someone else's shortcut must survive ours being removed.
  assert.match(g.store.get(`${SCHEMA} custom-keybindings`), /\/other\/custom0\//);
  assert.ok(g.calls.filter((c) => c.startsWith('reset ')).length >= 3);
});

test('unregistering the last shortcut writes the empty array GVariant needs', async () => {
  const g = fakeGsettings({ values: { [`${SCHEMA} custom-keybindings`]: `['${KEY_PATH}']` } });
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  await hk.unregister();
  // "[]" alone is an ambiguous GVariant and gsettings rejects it.
  assert.equal(g.store.get(`${SCHEMA} custom-keybindings`), '@as []');
});

test('a desktop that is not GNOME reports unsupported, not an error', async () => {
  const g = fakeGsettings({ schemas: ['org.gnome.desktop.interface'] });
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  const r = await hk.register('alt+space');
  // 'error' would make Settings tell the user to try again; the truth is that
  // this desktop stores shortcuts somewhere else entirely.
  assert.deepEqual(r, { ok: false, state: 'unsupported_de' });
});

test('no gsettings at all is unsupported too', async () => {
  const g = fakeGsettings();
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: () => null });
  assert.equal((await hk.register('alt+space')).state, 'unsupported_de');
});
