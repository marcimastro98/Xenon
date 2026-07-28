import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createScreens, parseDxgiInfo, dxgiToScreens } = require('../remote-control/screens.js');

// Output reale di dxgi-info.exe (3 monitor attivi su 2 GPU + un adapter senza output).
const DXGI_SAMPLE = `====== ADAPTER =====
Device Name       : NVIDIA GeForce RTX 5080
Device Vendor ID  : 0x000010DE

    ====== OUTPUT ======
    Output Name       : \\\\.\\DISPLAY1
    AttachedToDesktop : yes
    Resolution        : 3840x2160

====== ADAPTER =====
Device Name       : AMD Radeon(TM) Graphics

    ====== OUTPUT ======
    Output Name       : \\\\.\\DISPLAY5
    AttachedToDesktop : yes
    Resolution        : 1080x1920
    Output Name       : \\\\.\\DISPLAY6
    AttachedToDesktop : yes
    Resolution        : 2560x720

====== ADAPTER =====
Device Name       : Microsoft Basic Render Driver
`;

const sample = [
  { id: 'D1', name: 'Monitor 1', primary: true },
  { id: 'D2', name: 'Monitor 2', primary: false },
];

test('list ritorna i monitor con flag active sul selezionato', async () => {
  const screens = createScreens({ probe: async () => sample, getSelected: () => 'D2' });
  const list = await screens.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((s) => s.id === 'D2').active, true);
  assert.equal(list.find((s) => s.id === 'D1').active, false);
});

test('nextId cicla al monitor successivo', async () => {
  const screens = createScreens({ probe: async () => sample, getSelected: () => 'D1' });
  assert.equal(await screens.nextId(), 'D2');
});

test('nextId torna al primo dopo l ultimo', async () => {
  const screens = createScreens({ probe: async () => sample, getSelected: () => 'D2' });
  assert.equal(await screens.nextId(), 'D1');
});

test('nextId parte dal primo se nessuno selezionato', async () => {
  const screens = createScreens({ probe: async () => sample, getSelected: () => '' });
  assert.equal(await screens.nextId(), 'D1');
});

test('list vuota se probe non trova monitor', async () => {
  const screens = createScreens({ probe: async () => [], getSelected: () => '' });
  assert.deepEqual(await screens.list(), []);
});

test('parseDxgiInfo estrae i 3 output reali e salta l adapter senza output', () => {
  const parsed = parseDxgiInfo(DXGI_SAMPLE);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((o) => o.id), ['\\\\.\\DISPLAY1', '\\\\.\\DISPLAY5', '\\\\.\\DISPLAY6']);
  assert.equal(parsed[0].attached, true);
  assert.equal(parsed[0].resolution, '3840x2160');
  assert.equal(parsed[1].adapter, 'AMD Radeon(TM) Graphics');
});

test('dxgiToScreens mostra SOLO i monitor della GPU primaria (multi-GPU)', () => {
  // DISPLAY1 e' sulla NVIDIA (primo adapter); DISPLAY5/6 sono sulla AMD e NON
  // sono trasmettibili (cattura cross-GPU non supportata) -> esclusi.
  const screens = dxgiToScreens(parseDxgiInfo(DXGI_SAMPLE));
  assert.equal(screens.length, 1);
  assert.equal(screens[0].id, '\\\\.\\DISPLAY1');
  assert.equal(screens[0].name, 'DISPLAY1 · 3840x2160');
});

test('dxgiToScreens su GPU singola mostra tutti i monitor', () => {
  const single = `====== ADAPTER =====
Device Name       : NVIDIA GeForce RTX 5080
    ====== OUTPUT ======
    Output Name       : \\\\.\\DISPLAY1
    AttachedToDesktop : yes
    Resolution        : 3840x2160
    Output Name       : \\\\.\\DISPLAY2
    AttachedToDesktop : yes
    Resolution        : 2560x1440`;
  const screens = dxgiToScreens(parseDxgiInfo(single));
  assert.equal(screens.length, 2);
  assert.deepEqual(screens.map((s) => s.id), ['\\\\.\\DISPLAY1', '\\\\.\\DISPLAY2']);
});

test('parseDxgiInfo esclude gli output non attaccati al desktop', () => {
  const sample = `====== ADAPTER =====
Device Name       : GPU
    ====== OUTPUT ======
    Output Name       : \\\\.\\DISPLAY9
    AttachedToDesktop : no
    Resolution        : 0x0`;
  const screens = dxgiToScreens(parseDxgiInfo(sample));
  assert.deepEqual(screens, []);
});

test('probe di default usa il runner iniettato (dxgi-info) e mostra solo i trasmettibili', async () => {
  const runner = { run: async () => ({ code: 0, stdout: DXGI_SAMPLE, stderr: '' }) };
  const screens = createScreens({ runner, platform: 'win32', getSelected: () => '\\\\.\\DISPLAY1' });
  const list = await screens.list();
  assert.equal(list.length, 1, 'solo il monitor della GPU primaria e trasmettibile');
  assert.equal(list[0].id, '\\\\.\\DISPLAY1');
  assert.equal(list[0].active, true);
});

test('probe di default ritorna [] se dxgi-info fallisce', async () => {
  const runner = { run: async () => ({ code: 1, stdout: '', stderr: 'not found' }) };
  const screens = createScreens({ runner, platform: 'win32' });
  assert.deepEqual(await screens.list(), []);
});

// ── Linux: the kernel already knows ──────────────────────────────────────────
// There is no dxgi-info off Windows and no need for one: /sys/class/drm names
// every connector, and that NAME is exactly what Sunshine's KMS capture takes
// as output_name. xrandr was the obvious alternative and is the wrong one — it
// is X11-only, and reports nothing on the Wayland sessions most desktops now
// default to.
//
// The sample is what the port machine actually reported.

const DRM_SAMPLE = {
  'card1-DP-1': { status: 'disconnected', enabled: 'disabled', modes: '' },
  'card1-eDP-1': { status: 'connected', enabled: 'enabled', modes: '1920x1080\n1600x900\n' },
  'card1-HDMI-A-1': { status: 'connected', enabled: 'disabled', modes: '3840x2160\n' },
  'version': null,   // a non-connector entry that must be ignored
};

function fakeFs(sample) {
  return {
    readdirSync: () => Object.keys(sample),
    readFileSync: (p) => {
      const m = /\/([^/]+)\/([^/]+)$/.exec(p);
      const entry = sample[m[1]];
      if (!entry) throw new Error('ENOENT');
      return entry[m[2]] ?? '';
    },
  };
}

test('linux: elenca i connettori realmente pilotati, col nome che Sunshine accetta', async () => {
  const { createScreens } = require('../remote-control/screens.js');
  const screens = createScreens({ platform: 'linux', fsImpl: fakeFs(DRM_SAMPLE), getSelected: () => 'eDP-1' });
  const list = await screens.list();

  assert.deepEqual(list, [
    // Both connected ones, and only those: DP-1/DP-2 have nothing plugged in,
    // and `version` is not a connector at all.
    { id: 'eDP-1', name: 'eDP-1 · 1920x1080', primary: false, active: true },
    { id: 'HDMI-A-1', name: 'HDMI-A-1 · 3840x2160', primary: false, active: false },
  ]);
});

test('linux: uno schermo che si spegne NON sparisce dall\'elenco', async () => {
  // The bug this test exists for. Filtering on `enabled` as well as `connected`
  // looks more precise and is wrong: `enabled` tracks the live modeset, so it
  // goes `disabled` the moment the panel blanks. Found by running the probe on
  // the port machine twice minutes apart — the laptop display went to DPMS Off
  // in between and the list went from one entry to zero, which would have
  // emptied the picker and dropped the user's chosen screen every time the
  // screen slept.
  const { drmToScreens } = require('../remote-control/screens.js');
  const asleep = drmToScreens([
    { name: 'eDP-1', connected: true, enabled: false, resolution: '1920x1080' },
  ]);
  assert.deepEqual(asleep.map((s) => s.id), ['eDP-1']);

  // A port with nothing plugged into it is still not a screen.
  const empty = drmToScreens([
    { name: 'HDMI-A-1', connected: false, enabled: false, resolution: '' },
  ]);
  assert.deepEqual(empty, []);
});

test('linux: /sys assente non fa esplodere niente', async () => {
  const { createScreens } = require('../remote-control/screens.js');
  const screens = createScreens({
    platform: 'linux',
    fsImpl: { readdirSync: () => { throw new Error('ENOENT'); }, readFileSync: () => '' },
  });
  assert.deepEqual(await screens.list(), []);
});

test('darwin: nessun elenco, invece di un elenco sbagliato', async () => {
  // Sunshine identifies displays by index on macOS and there is no supported
  // way to enumerate them from outside the app. An empty list makes the panel
  // hide its screen picker; inventing one would let the user pick a monitor
  // that does not map to anything.
  const { createScreens } = require('../remote-control/screens.js');
  const screens = createScreens({ platform: 'darwin' });
  assert.deepEqual(await screens.list(), []);
});
