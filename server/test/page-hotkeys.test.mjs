// Global page shortcuts: a key combination registered on the PC turns the
// dashboard's page while the user is in another application.
//
// The moving part is an INDEX. The helper is handed a list of combos and
// reports a press by its position in that list, so the array the server builds
// is the wire format — get its order wrong and Ctrl+Alt+2 opens somebody else's
// page. Three things therefore have to agree: the table the server builds, the
// helper's own addressing, and (on Linux, where a desktop entry pokes a URL
// rather than a process pushing an event) the index baked into each command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createLinuxHotkey, keyPathFor, commandFor, KEY_PATH, KEY_ROOT, SCHEMA, CUSTOM_SCHEMA } from '../linux-hotkey.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = readFileSync(join(ROOT, 'server.js'), 'utf8');
const DeckShortcuts = createRequire(import.meta.url)('../js/deck-shortcuts.js');
const LayersModel = createRequire(import.meta.url)('../js/layers-model.js');
const CaptureSettings = createRequire(import.meta.url)('../capture-settings.js');
const CLIENT = readFileSync(join(ROOT, 'js', 'settings.js'), 'utf8');
const CS = readFileSync(join(ROOT, '..', 'helper', 'HotkeyHost.cs'), 'utf8');
const SWIFT = readFileSync(join(ROOT, '..', 'helper-mac', 'Sources', 'xenon-helper', 'HotkeyHost.swift'), 'utf8');

// Run the real source rather than asserting on its text.
function loadFn(src, name) {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(`const MAX_PAGE_HOTKEYS = 8;\n${m[0]}; return ${name};`)();
}

// ── the stored shape, on both sides ─────────────────────────────────────────
for (const [side, src] of [['server', SERVER], ['client', CLIENT]]) {
  test(`${side}: a shortcut needs both a combination and a target`, () => {
    const N = loadFn(src, 'normalizePageHotkeys');
    assert.deepEqual(N([{ combo: 'ctrl+alt+1', target: 'home' }]), [{ combo: 'ctrl+alt+1', target: 'home' }]);
    assert.deepEqual(N([{ combo: '', target: 'home' }]), []);
    assert.deepEqual(N([{ combo: 'ctrl+alt+1', target: '' }]), []);
    assert.deepEqual(N([{ combo: 'ctrl+alt+1' }]), []);
    assert.deepEqual(N('nonsense'), []);
    assert.deepEqual(N([null, 7, 'x']), []);
  });

  test(`${side}: one combination cannot carry two actions`, () => {
    // Windows refuses the second RegisterHotKey and GNOME fires neither, so a
    // duplicate is not "last one wins" anywhere — it is one working shortcut
    // and one that silently is not there.
    const N = loadFn(src, 'normalizePageHotkeys');
    assert.deepEqual(
      N([{ combo: 'ctrl+alt+1', target: 'a' }, { combo: 'CTRL+ALT+1', target: 'b' }]),
      [{ combo: 'ctrl+alt+1', target: 'a' }],
    );
  });

  test(`${side}: a target this device does not have is KEPT`, () => {
    // Pages belong to a device's own layout and this list is shared by all of
    // them. Dropping an id the saving device happens not to have would delete
    // another screen's shortcut on every save.
    const N = loadFn(src, 'normalizePageHotkeys');
    assert.deepEqual(N([{ combo: 'ctrl+alt+1', target: 'a-page-only-the-tv-has' }]),
      [{ combo: 'ctrl+alt+1', target: 'a-page-only-the-tv-has' }]);
    for (const move of ['next', 'prev', 'back']) {
      assert.deepEqual(N([{ combo: 'ctrl+alt+1', target: move }]), [{ combo: 'ctrl+alt+1', target: move }]);
    }
  });

  test(`${side}: the list is bounded and shell-shaped input cannot reach the helper`, () => {
    const N = loadFn(src, 'normalizePageHotkeys');
    const many = Array.from({ length: 30 }, (_, i) => ({ combo: 'ctrl+alt+' + (i % 10), target: 'p' + i }));
    assert.ok(N(many).length <= 8);
    // The combos become argv for the helper and part of a desktop command line.
    for (const bad of ['ctrl+alt+$(id)', 'ctrl;reboot', 'ctrl+alt+"x"', 'a`b`', "ctrl+alt+'"]) {
      assert.deepEqual(N([{ combo: bad, target: 'home' }]), [], `accepted ${bad}`);
    }
  });
}

test('both sides normalize page shortcuts the same way', () => {
  const S = loadFn(SERVER, 'normalizePageHotkeys');
  const C = loadFn(CLIENT, 'normalizePageHotkeys');
  const cases = [
    undefined, [], 'x',
    [{ combo: 'ctrl+alt+1', target: 'home' }, { combo: 'ctrl+alt+1', target: 'other' }],
    [{ combo: ' CTRL+ALT+F5 ', target: 'next' }],
    [{ combo: 'ctrl+alt+$', target: 'home' }],
    Array.from({ length: 12 }, (_, i) => ({ combo: 'ctrl+alt+' + i, target: 'p' })),
  ];
  for (const c of cases) assert.deepEqual(S(c), C(c), `diverged on ${JSON.stringify(c)}`);
});

// ── the binding table IS the wire format ────────────────────────────────────
function loadBindings(settings, deckConfigs, engine = true, menuShell = false) {
  const m = SERVER.match(/function _hotkeyBindings\(\) \{[\s\S]*?\n\}/);
  const o = SERVER.match(/function _overlayHotkey\(\) \{[\s\S]*?\n\}/);
  const r = SERVER.match(/function _replayHotkey\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, '_hotkeyBindings not found');
  assert.ok(o, '_overlayHotkey not found');
  assert.ok(r, '_replayHotkey not found');
  const mk = SERVER.match(/function _menuHotkey\(\) \{[\s\S]*?\n\}/);
  assert.ok(mk, '_menuHotkey not found');
  const screenMenu = { available: () => menuShell };
  const deck = DeckShortcuts.collectShortcuts(deckConfigs || {});
  const captureOptions = () => CaptureSettings.normalizeCaptureSettings(settings && settings.capture);
  const host = { available: () => engine, has: (f) => engine && f === 'replay' };
  // eslint-disable-next-line no-new-func
  return new Function('_serverHubSettings', 'DeckShortcuts', '_deckShortcuts', 'LayersModel', 'captureOptions', '_captureHost', 'screenMenu',
    `const MAX_HOTKEY_BINDINGS = 16;\n${m[0]}\n${o[0]}\n${r[0]}\n${mk[0]}; return _hotkeyBindings();`)(settings, DeckShortcuts, deck, LayersModel, captureOptions, host, screenMenu);
}

// Layers with one widget on the given surface.
function layersWith(surface, extra) {
  return { enabled: true, widgets: [{ id: 'lw_abcd1', kind: 'tile', widget: 'perf', surface }], ...extra };
}

test('the overlay shortcut is held only while a widget is in the overlay, and goes last', () => {
  assert.deepEqual(loadBindings({ layers: layersWith('overlay') }), [{ slot: 'overlay', combo: 'ctrl+shift+f9' }]);
  assert.deepEqual(loadBindings({ layers: layersWith('desktop') }), [], 'nothing in the overlay, nothing held');
  assert.deepEqual(loadBindings({ layers: layersWith('overlay', { enabled: false }) }), []);
  assert.deepEqual(loadBindings({ layers: layersWith('overlay', { overlayKey: 'off' }) }), [], 'turned off by the user');
  assert.deepEqual(loadBindings({ layers: layersWith('overlay', { overlayKey: 'alt+shift+o' }) }), [{ slot: 'overlay', combo: 'alt+shift+o' }]);
  // A combo the user put on a Deck key wins: the default steps aside.
  const out = loadBindings({ searchSettings: { hotkeyEnabled: true, hotkeyCombo: 'alt+space' }, layers: layersWith('overlay') }, deckWith('ctrl+shift+f9'));
  assert.deepEqual(out.map((b) => b.slot), ['spotlight', 'deck-0']);
  const after = loadBindings({ searchSettings: { hotkeyEnabled: true, hotkeyCombo: 'alt+space' }, layers: layersWith('overlay') }, deckWith('ctrl+alt+shift+k'));
  assert.deepEqual(after.map((b) => b.slot), ['spotlight', 'deck-0', 'overlay']);
  // Never past what the helper registers.
  const pageHotkeys = Array.from({ length: 16 }, (_, i) => ({ combo: 'ctrl+alt+shift+' + i, target: 'p' + i }));
  const full = loadBindings({ searchSettings: { hotkeyEnabled: false }, pageHotkeys, layers: layersWith('overlay') });
  assert.ok(full.length <= 16);
  assert.ok(!full.some((b) => b.slot === 'overlay'), 'no room, no overlay shortcut');
});

test('the overlay shortcut toggles the overlay alone, and a layers edit re-arms it', () => {
  assert.match(SERVER, /binding\.slot === 'overlay'\) capabilityRunner\.run\(\{ type: 'layersToggle', mode: 'toggle', surface: 'overlay' \}\)/);
  assert.match(SERVER, /b\.slot === 'overlay' \? 'Xenon overlay'/);
  const upd = SERVER.slice(SERVER.indexOf('async function updateLayersSetting'));
  assert.match(upd.slice(0, 1200), /if \(_overlayHotkey\(\) \+ '\|' \+ _menuHotkey\(\) !== keys\) \{ try \{ refreshHotkeyListener\(\); \}/);
});

test('the Xenon menu shortcut is held only with a shell that draws the menu, and goes last', () => {
  assert.deepEqual(loadBindings({}, null, true, true), [{ slot: 'menu', combo: 'alt+shift+x' }]);
  assert.deepEqual(loadBindings({}, null, true, false), [], 'no shell, the combo stays free');
  assert.deepEqual(loadBindings({ layers: { menuKey: 'off' } }, null, true, true), [], 'turned off by the user');
  assert.deepEqual(loadBindings({ layers: { menuKey: 'ctrl+alt+m' } }, null, true, true), [{ slot: 'menu', combo: 'ctrl+alt+m' }]);
  // A Deck key on the same combo wins.
  assert.deepEqual(loadBindings({}, deckWith('alt+shift+x'), true, true).map((b) => b.slot), ['deck-0']);
  assert.match(SERVER, /binding\.slot === 'menu'\) screenMenu\.toggle\(\)/);
  assert.match(SERVER, /b\.slot === 'menu' \? 'Xenon menu'/, 'named on the desktop, never "Xenon page NaN"');
});

// A Deck config holding one action key per shortcut given.
function deckWith(...combos) {
  const keys = combos.map((c, i) => ({ kind: 'action', id: 'k' + i, title: 'Key ' + i, shortcut: c, triggers: { tap: { type: 'mediaKey', key: 'play' } } }));
  return { main: { profiles: [{ name: 'P', root: { pages: [{ keys }] } }] } };
}

test('Deck key shortcuts come after the search and page ones', () => {
  const out = loadBindings({
    searchSettings: { hotkeyEnabled: true, hotkeyCombo: 'alt+space' },
    pageHotkeys: [{ combo: 'ctrl+alt+1', target: 'home' }],
  }, deckWith('ctrl+shift+f9', 'ctrl+alt+shift+k'));
  assert.deepEqual(out.map((b) => b.slot), ['spotlight', 'page-0', 'deck-0', 'deck-1']);
  assert.equal(out[2].keyId, 'k0');
  assert.equal(out[3].combo, 'ctrl+alt+shift+k');
});

test('a Deck shortcut never takes a combo a page already holds, nor a slot past 16', () => {
  const pageHotkeys = Array.from({ length: 15 }, (_, i) => ({ combo: 'ctrl+alt+shift+' + i, target: 'p' }));
  const out = loadBindings({ searchSettings: { hotkeyEnabled: false }, pageHotkeys },
    deckWith('ctrl+alt+shift+0', 'ctrl+shift+f9', 'ctrl+shift+f10'));
  assert.equal(out.length, 16);
  assert.deepEqual(out.filter((b) => b.keyId).map((b) => b.keyId), ['k1']);
  const plan = DeckShortcuts.planBindings(out.filter((b) => !b.keyId), DeckShortcuts.collectShortcuts(
    deckWith('ctrl+alt+shift+0', 'ctrl+shift+f9', 'ctrl+shift+f10')).list, 16);
  assert.deepEqual(plan.refused, { k0: 'clash', k2: 'full' });
});

test('the Linux entries for Deck shortcuts get their own name', () => {
  assert.match(SERVER, /b\.keyId \? 'Xenon shortcut ' : 'Xenon page '/);
  assert.match(SERVER, /else if \(binding\.keyId\) deckShortcutRunner\.press\(binding\.keyId, binding\.combo\)/);
});

test('Spotlight takes index 0 whenever it is on', () => {
  // This is the compatibility story: a helper too old to understand a list
  // registers the FIRST combo and reports a press with no index, which reads as
  // index 0. On a stale binary the search shortcut therefore still works and
  // the page ones are simply absent, rather than one of them being triggered
  // in its place.
  const out = loadBindings({
    searchSettings: { hotkeyEnabled: true, hotkeyCombo: 'alt+space' },
    pageHotkeys: [{ combo: 'ctrl+alt+1', target: 'home' }],
  });
  assert.equal(out[0].slot, 'spotlight');
  assert.equal(out[0].combo, 'alt+space');
  assert.equal(out[1].slot, 'page-0');
  assert.equal(out[1].target, 'home');
});

test('with Spotlight off the page shortcuts close the gap', () => {
  const out = loadBindings({
    searchSettings: { hotkeyEnabled: false },
    pageHotkeys: [{ combo: 'ctrl+alt+1', target: 'home' }, { combo: 'ctrl+alt+2', target: 'work' }],
  });
  assert.deepEqual(out.map((b) => b.slot), ['page-0', 'page-1']);
  assert.equal(out[0].target, 'home');
});

test('a slot keeps its number when Spotlight is toggled', () => {
  // The slot names the row in Settings; the INDEX is what moves. Confusing the
  // two would renumber every row's status the moment the search shortcut is
  // switched off.
  const pageHotkeys = [{ combo: 'ctrl+alt+1', target: 'home' }];
  const on = loadBindings({ searchSettings: { hotkeyEnabled: true, hotkeyCombo: 'alt+space' }, pageHotkeys });
  const off = loadBindings({ searchSettings: { hotkeyEnabled: false }, pageHotkeys });
  assert.equal(on.find((b) => b.slot === 'page-0').target, 'home');
  assert.equal(off.find((b) => b.slot === 'page-0').target, 'home');
  assert.equal(on.indexOf(on.find((b) => b.slot === 'page-0')), 1);
  assert.equal(off.indexOf(off.find((b) => b.slot === 'page-0')), 0);
});

test('nothing configured means no child process at all', () => {
  assert.deepEqual(loadBindings({ searchSettings: { hotkeyEnabled: false }, pageHotkeys: [] }), []);
  assert.deepEqual(loadBindings({}), []);
});

test('the table cannot grow past what the helper will register', () => {
  const out = loadBindings({
    searchSettings: { hotkeyEnabled: true, hotkeyCombo: 'alt+space' },
    pageHotkeys: Array.from({ length: 40 }, (_, i) => ({ combo: 'ctrl+alt+' + i, target: 'p' })),
  });
  assert.ok(out.length <= 16, `built ${out.length} bindings`);
  assert.match(CS, /MAX_COMBOS = 16/);
  assert.match(SWIFT, /maxCombos = 16/);
});

// ── the helpers address a combo by position ─────────────────────────────────
test('both helpers report which combo fired, and survive one being taken', () => {
  for (const [name, src] of [['C#', CS], ['Swift', SWIFT]]) {
    // A press carries its index…
    assert.match(src, /"hotkey"/, `${name}: no hotkey event`);
    assert.match(src, /index/, `${name}: presses are not addressed`);
    // …and a combo somebody else owns is skipped, not fatal. The old code
    // returned on the first failure, which with a list would mean one clash
    // silently disabling every shortcut after it.
    assert.match(src, /continue/, `${name}: a taken combo still aborts the rest`);
  }
  // Only when NONE registered does the host give up — the single-combo case.
  assert.match(CS, /if \(registered\.Count == 0\) return 1;/);
  assert.match(SWIFT, /if registered\.isEmpty \{ exit\(1\) \}/);
});

test('the helper version gates are bumped together with the protocol', () => {
  // An install that keeps an older binary registers only the first combo, so
  // every page shortcut would be dead with nothing on screen to say why.
  const csproj = readFileSync(join(ROOT, '..', 'helper', 'XenonHelper.csproj'), 'utf8');
  const psMin = readFileSync(join(ROOT, 'helper-update.ps1'), 'utf8');
  const swiftVer = readFileSync(join(ROOT, '..', 'helper-mac', 'Sources', 'xenon-helper', 'Version.swift'), 'utf8');
  const shMin = readFileSync(join(ROOT, 'install.sh'), 'utf8');
  const win = /<Version>([\d.]+)<\/Version>/.exec(csproj);
  const winGate = /\$minVersion = \[Version\]'([\d.]+)'/.exec(psMin);
  const mac = /let helperVersion = "([\d.]+)"/.exec(swiftVer);
  const macGate = /MIN_MAC_HELPER='([\d.]+)'/.exec(shMin);
  assert.ok(win && winGate && mac && macGate, 'a version marker is gone');
  assert.equal(winGate[1], win[1], 'helper-update.ps1 does not require the helper this repo builds');
  assert.equal(macGate[1], mac[1], 'install.sh does not require the mac helper this repo builds');
});

// ── Linux: one desktop entry per slot, each carrying its own index ──────────
function fakeGsettings(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    runner: async (cmd, args) => {
      if (cmd !== 'gsettings') return null;
      const [op] = args;
      if (op === 'list-schemas') return SCHEMA + '\n';
      if (op === 'list-recursively') return '';
      if (op === 'get') return store.get(`${args[1]} ${args[2]}`) ?? "''";
      if (op === 'set') { store.set(`${args[1]} ${args[2]}`, args[3]); return ''; }
      if (op === 'reset') { store.delete(`${args[1]} ${args[2]}`); return ''; }
      return null;
    },
  };
}
const lookup = (bin) => (bin === 'gsettings' ? '/usr/bin/gsettings' : bin === 'curl' ? '/usr/bin/curl' : null);

test('each page shortcut gets its own entry, its own index, and its own name', () => {
  assert.equal(keyPathFor('spotlight'), KEY_PATH);
  assert.equal(keyPathFor('page-0'), KEY_ROOT + 'xenon-page-0/');
  // A slot id reaches dconf as part of an object path.
  assert.equal(keyPathFor('../../etc'), null);
  assert.equal(keyPathFor("x'; rm -rf /"), null);
  assert.match(commandFor(3030, { curl: '/usr/bin/curl' }, '/pages/hotkey-press?i=3'),
    /-X POST http:\/\/127\.0\.0\.1:3030\/pages\/hotkey-press\?i=3$/);
});

test('syncSlots writes every shortcut and each one pokes its own index', async () => {
  const g = fakeGsettings();
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  const r = await hk.syncSlots([
    { slot: 'page-0', combo: 'ctrl+alt+1', name: 'Xenon page 1', route: '/pages/hotkey-press?i=1' },
    { slot: 'page-1', combo: 'ctrl+alt+2', name: 'Xenon page 2', route: '/pages/hotkey-press?i=2' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.slots['page-0'].state, 'listening');
  assert.equal(r.slots['page-1'].state, 'listening');
  assert.equal(g.store.get(`${CUSTOM_SCHEMA}:${KEY_ROOT}xenon-page-0/ binding`), '<Control><Alt>1');
  assert.match(g.store.get(`${CUSTOM_SCHEMA}:${KEY_ROOT}xenon-page-1/ command`), /i=2$/);
  const paths = g.store.get(`${SCHEMA} custom-keybindings`);
  assert.match(paths, /xenon-page-0/);
  assert.match(paths, /xenon-page-1/);
});

test('our own slots are not conflicts with each other', async () => {
  // Registering is a one-shot write, so every settings save re-runs the whole
  // sync over shortcuts that are ALREADY in the desktop's list — our own, from
  // the last save. Read back as somebody else's bindings they clash with
  // themselves, and the second save turns every shortcut 'taken' and dead.
  // So this has to sync twice: the first pass is what makes the second one a
  // real test.
  const g = fakeGsettings();
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  const wanted = [
    { slot: 'page-0', combo: 'ctrl+alt+1', name: 'a', route: '/pages/hotkey-press?i=0' },
    { slot: 'page-1', combo: 'ctrl+alt+2', name: 'b', route: '/pages/hotkey-press?i=1' },
    { slot: 'page-2', combo: 'ctrl+alt+3', name: 'c', route: '/pages/hotkey-press?i=2' },
  ];
  const first = await hk.syncSlots(wanted);
  assert.deepEqual(Object.values(first.slots).map((s) => s.state), ['listening', 'listening', 'listening']);
  const again = await hk.syncSlots(wanted);
  assert.deepEqual(Object.values(again.slots).map((s) => s.state), ['listening', 'listening', 'listening'],
    'a second save clashes with the shortcuts the first one wrote');
  // And the Spotlight entry beside them is not a conflict either.
  await hk.register('alt+space');
  const withSpotlight = await hk.syncSlots(wanted);
  assert.deepEqual(Object.values(withSpotlight.slots).map((s) => s.state), ['listening', 'listening', 'listening']);
});

test('two of our own slots on one accelerator is still refused', async () => {
  // GNOME fires neither, so accepting it would be a shortcut that reports
  // listening and does nothing.
  const g = fakeGsettings();
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  const r = await hk.syncSlots([
    { slot: 'page-0', combo: 'ctrl+alt+1', name: 'a', route: '/pages/hotkey-press?i=0' },
    { slot: 'page-1', combo: 'ctrl+alt+1', name: 'b', route: '/pages/hotkey-press?i=1' },
  ]);
  assert.equal(r.slots['page-0'].state, 'listening');
  assert.equal(r.slots['page-1'].state, 'taken');
});

test('a shortcut the user removed stops existing', async () => {
  const g = fakeGsettings();
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  await hk.syncSlots([
    { slot: 'page-0', combo: 'ctrl+alt+1', name: 'a', route: '/pages/hotkey-press?i=0' },
    { slot: 'page-1', combo: 'ctrl+alt+2', name: 'b', route: '/pages/hotkey-press?i=1' },
  ]);
  await hk.syncSlots([{ slot: 'page-0', combo: 'ctrl+alt+1', name: 'a', route: '/pages/hotkey-press?i=0' }]);
  const paths = g.store.get(`${SCHEMA} custom-keybindings`);
  assert.match(paths, /xenon-page-0/);
  assert.ok(!/xenon-page-1/.test(paths), 'the removed shortcut is still bound');
  // …and leaves nothing behind for a later re-register to inherit.
  assert.equal(g.store.get(`${CUSTOM_SCHEMA}:${KEY_ROOT}xenon-page-1/ binding`), undefined);
});

test('syncing pages never touches the Spotlight shortcut', async () => {
  const g = fakeGsettings();
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  await hk.register('alt+space');
  await hk.syncSlots([{ slot: 'page-0', combo: 'ctrl+alt+1', name: 'a', route: '/pages/hotkey-press?i=1' }]);
  assert.equal(g.store.get(`${CUSTOM_SCHEMA}:${KEY_PATH} binding`), '<Alt>space');
  assert.match(g.store.get(`${SCHEMA} custom-keybindings`), /xenon-spotlight/);
});

test("another app's shortcut is left alone", async () => {
  const g = fakeGsettings({
    [`${SCHEMA} custom-keybindings`]: "['/other/custom0/']",
    [`${CUSTOM_SCHEMA}:/other/custom0/ binding`]: "'<Primary><Alt>1'",
  });
  const hk = createLinuxHotkey({ port: 3030, runner: g.runner, which: lookup });
  const r = await hk.syncSlots([{ slot: 'page-0', combo: 'ctrl+alt+1', name: 'a', route: '/pages/hotkey-press?i=0' }]);
  // <Primary> is Control spelled another way — compared normalised, not raw.
  assert.equal(r.slots['page-0'].state, 'taken');
  assert.match(g.store.get(`${SCHEMA} custom-keybindings`), /other\/custom0/);
});

// ── the press is broadcast, never resolved on the server ────────────────────
test('the server broadcasts the target and lets each screen resolve it', () => {
  const m = /function routePageHotkey\(binding\) \{[\s\S]*?\n\}/.exec(SERVER);
  assert.ok(m, 'routePageHotkey is gone');
  assert.match(m[0], /broadcastSSE\('page_hotkey', \{ target: binding\.target/);
  // A page id belongs to ONE device's layout; resolving it here would mean
  // guessing whose.
  assert.ok(!/dashboardLayout/.test(m[0]), 'the server is resolving page ids');

  const r = /function routeHotkeyIndex\(index\) \{[\s\S]*?\n\}/.exec(SERVER);
  assert.ok(r, 'routeHotkeyIndex is gone');
  assert.match(r[0], /if \(!binding\) return;/, 'an unknown index is not guarded');
  assert.match(r[0], /binding\.slot === 'spotlight'/);
});

test('the Linux press route reads its index off the parsed URL', () => {
  // reqPath is the pathname alone and carries no query, so parsing the index
  // out of it silently gave null and every Linux page shortcut did nothing.
  const m = /reqPath === '\/pages\/hotkey-press'[\s\S]*?routeHotkeyIndex\(at\)/.exec(SERVER);
  assert.ok(m, 'the press route is gone');
  assert.match(m[0], /urlObj\.searchParams\.get\('i'\)/);
  assert.ok(!/new URL\(reqPath/.test(m[0]), 'the index is being parsed out of a query-less path');
});

// ── Instant Replay's save shortcut ──────────────────────────────────────────
test('the replay shortcut is held only while the replay is on and the engine runs, and goes last', () => {
  assert.deepEqual(loadBindings({ capture: { replay: true } }), [{ slot: 'replay', combo: 'ctrl+shift+f10' }]);
  assert.deepEqual(loadBindings({ capture: { replay: false } }), [], 'replay off: the combo stays free for other apps');
  assert.deepEqual(loadBindings({ capture: { replay: true } }, null, false), [], 'no engine: pressing could not save anything');
  assert.deepEqual(loadBindings({ capture: { replay: true, replayKey: 'off' } }), [], 'turned off by the user');
  assert.deepEqual(loadBindings({ capture: { replay: true, replayKey: 'alt+shift+r' } }), [{ slot: 'replay', combo: 'alt+shift+r' }]);
  // A stored combo someone else owns never reaches the helper.
  assert.deepEqual(loadBindings({ capture: { replay: true, replayKey: 'alt+f10' } }), [{ slot: 'replay', combo: 'ctrl+shift+f10' }]);
  // After the overlay, and a Deck key on the same combo wins.
  const both = loadBindings({ capture: { replay: true }, layers: layersWith('overlay') });
  assert.deepEqual(both.map((b) => b.slot), ['overlay', 'replay']);
  const clash = loadBindings({ capture: { replay: true } }, deckWith('ctrl+shift+f10'));
  assert.deepEqual(clash.map((b) => b.slot), ['deck-0']);
  const pageHotkeys = Array.from({ length: 16 }, (_, i) => ({ combo: 'ctrl+alt+shift+' + i, target: 'p' + i }));
  assert.ok(!loadBindings({ pageHotkeys, capture: { replay: true } }).some((b) => b.slot === 'replay'), 'no room, no replay shortcut');
});

test('the replay shortcut saves the replay, says a failure, and a capture change re-arms it', () => {
  assert.match(SERVER, /binding\.slot === 'replay'\) _pressReplayHotkey\(\);/);
  assert.match(SERVER, /b\.slot === 'replay' \? 'Xenon replay'/);
  const press = SERVER.slice(SERVER.indexOf('function _pressReplayHotkey()'));
  assert.match(press.slice(0, 600), /capabilityRunner\.run\(\{ type: 'replay', mode: 'save' \}\)/);
  assert.match(press.slice(0, 600), /broadcastSSE\('deck_shortcut_failed', \{ title: 'Instant Replay', error: \(r && r\.error\) \|\| 'failed' \}\)/);
  const upd = SERVER.slice(SERVER.indexOf('async function updateCaptureSettings'));
  assert.match(upd.slice(0, 1400), /if \(_replayHotkey\(\) !== replayKey\) \{ try \{ refreshHotkeyListener\(\); \}/);
});
