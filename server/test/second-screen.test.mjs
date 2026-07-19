import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSecondScreen, buildConfigXml } = require('../second-screen.js');

// Fake winget installer (mirrors remote-control/installer.js) so tests never touch
// winget or elevate anything.
// `install` flips the installed state like winget does, because installDriver now
// trusts a re-probe over winget's exit code (which is non-zero for benign cases
// such as "already installed" or "reboot required"). `installSucceeds: false`
// models a package that really did not land.
function fakeInstaller({ winget = true, vdd = false, installCode = 0, installSucceeds = true } = {}) {
  const calls = [];
  let installed = vdd;
  return {
    calls,
    isWingetAvailable: async () => winget,
    isInstalled: async (name) => { calls.push(['isInstalled', name]); return name === 'vdd' ? installed : false; },
    install: async (name) => {
      calls.push(['install', name]);
      if (name === 'vdd' && installSucceeds) installed = true;
      return { code: installCode };
    },
  };
}

function fakeRunner({ elevatedCode = 0 } = {}) {
  const calls = [];
  return {
    calls,
    run: async () => ({ code: 0, stdout: '0' }),
    runElevated: async (exe, args) => { calls.push([exe, ...args]); return { code: elevatedCode }; },
  };
}

const deps = (over = {}) => ({
  installer: fakeInstaller(over.inst),
  runner: fakeRunner(over.run),
  findPackageDir: () => over.dir ?? 'C:\\pkg\\vdd',
  writeConfig: over.writeConfig || (() => {}),
  probeDisplayActive: over.probe || (async () => over.displayActive === true),
});

test('requirements: winget missing → manual guided step, not ready', async () => {
  const ss = createSecondScreen(deps({ inst: { winget: false } }));
  const r = await ss.requirements();
  assert.equal(r.ready, false);
  assert.equal(r.steps[0].action, 'manual');
  assert.equal(r.steps[0].code, 'winget_missing');
});

test('requirements: VDD not installed → install actions for vdd + display', async () => {
  const ss = createSecondScreen(deps({ inst: { vdd: false } }));
  const r = await ss.requirements();
  assert.equal(r.ready, false);
  assert.equal(r.steps.find((s) => s.id === 'vdd').action, 'install');
  assert.equal(r.steps.find((s) => s.id === 'display').code, 'display_missing');
});

test('requirements: driver installed but no display → display step needs creating', async () => {
  const ss = createSecondScreen(deps({ inst: { vdd: true }, displayActive: false }));
  const r = await ss.requirements();
  assert.equal(r.ready, false);
  assert.equal(r.vddInstalled, true);
  assert.equal(r.displayActive, false);
  assert.equal(r.steps.find((s) => s.id === 'display').action, 'install');
});

test('requirements: driver + active display → ready', async () => {
  const ss = createSecondScreen(deps({ inst: { vdd: true }, displayActive: true }));
  const r = await ss.requirements();
  assert.equal(r.ready, true);
  assert.ok(r.steps.every((s) => s.ok));
});

test('installDriver: installs the VDD package', async () => {
  const d = deps();
  const r = await createSecondScreen(d).installDriver();
  assert.equal(r.ok, true);
  assert.equal(r.code, 'vdd_installed');
  assert.deepEqual(d.installer.calls.find((c) => c[0] === 'install'), ['install', 'vdd']);
});

// winget reports non-zero for benign outcomes ("already installed", "reboot
// required"), so a non-zero exit with the package present must NOT read as a
// failed setup — the UI would tell the user to retry something that worked.
test('installDriver: non-zero winget exit but package present → success', async () => {
  const r = await createSecondScreen(deps({ inst: { installCode: 0x8A15002B } })).installDriver();
  assert.equal(r.ok, true);
  assert.equal(r.code, 'vdd_installed');
});

test('installDriver: package still absent afterwards → retry code', async () => {
  const r = await createSecondScreen(deps({ inst: { installSucceeds: false } })).installDriver();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'vdd_install_failed');
});

test('installDriver: UAC declined → its own code, distinct from a failure', async () => {
  const r = await createSecondScreen(deps({ inst: { installCode: 1223, installSucceeds: false } })).installDriver();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'vdd_install_declined');
});

test('installDriver: winget missing → manual code, no throw', async () => {
  const r = await createSecondScreen(deps({ inst: { winget: false } })).installDriver();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'winget_missing');
});

test('createDisplay: writes config, then removes existing devnodes BEFORE installing one', async () => {
  let wrote = '';
  const d = deps({ writeConfig: (xml) => { wrote = xml; }, displayActive: true });
  const r = await createSecondScreen(d).createDisplay({ width: 1920, height: 1080 });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'display_ready');
  assert.match(wrote, /<count>1<\/count>/);
  // Always remove-then-install so the monitor count can never grow (anti-spam,
  // self-healing). Order matters: remove first, install second.
  assert.equal(d.runner.calls[0][1], 'remove');
  assert.equal(d.runner.calls[1][1], 'install');
  assert.match(d.runner.calls[1][0], /devcon\.exe$/);
  assert.equal(d.runner.calls[1][d.runner.calls[1].length - 1], 'Root\\MttVDD');
});

test('createDisplay: device created but not yet enumerated → reboot hint', async () => {
  const d = deps({ writeConfig: () => {}, displayActive: false });
  const r = await createSecondScreen(d).createDisplay();
  assert.equal(r.ok, true);
  assert.equal(r.code, 'display_needs_reboot');
  assert.equal(r.action, 'reboot_maybe');
});

// devcon exit codes: 0 = done, 1 = done but a reboot is needed, 2 = failed.
test('createDisplay: devcon failure → retry code', async () => {
  const d = deps({ run: { elevatedCode: 2 }, writeConfig: () => {} });
  const r = await createSecondScreen(d).createDisplay();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'display_create_failed');
});

test('createDisplay: devcon exit 1 means "reboot needed", not failure', async () => {
  const d = deps({ run: { elevatedCode: 1 }, writeConfig: () => {}, displayActive: true });
  const r = await createSecondScreen(d).createDisplay();
  assert.equal(r.ok, true);
  assert.equal(r.code, 'display_ready');
});

test('createDisplay: UAC declined → its own code, distinct from a failure', async () => {
  const d = deps({ run: { elevatedCode: 1223 }, writeConfig: () => {} });
  const r = await createSecondScreen(d).createDisplay();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'display_create_declined');
});

test('createDisplay: package files missing → guided code', async () => {
  const r = await createSecondScreen(deps({ dir: '' })).createDisplay();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'vdd_files_missing');
});

test('removeDisplay: runs devcon remove', async () => {
  const d = deps();
  const r = await createSecondScreen(d).removeDisplay();
  assert.equal(r.ok, true);
  // path.join builds the devcon path, so its separator follows the host OS
  // (backslash on the Windows target, forward slash when the suite runs on a
  // POSIX CI). Normalize it before matching; the device id is a literal, not a path.
  const call = d.runner.calls[0];
  assert.equal(call[0].replace(/\//g, '\\'), 'C:\\pkg\\vdd\\Dependencies\\devcon.exe');
  assert.deepEqual(call.slice(1), ['remove', 'Root\\MttVDD']);
});

test('buildConfigXml: clamps to sane bounds', () => {
  const xml = buildConfigXml({ width: 99999, height: 100, refresh: 9999 });
  assert.match(xml, /<width>7680<\/width>/);
  assert.match(xml, /<height>480<\/height>/);
  assert.match(xml, /<refresh_rate>244<\/refresh_rate>/);
});

test('buildConfigXml: full schema advertising every preset (so resolution changes need no reinstall)', () => {
  const xml = buildConfigXml({ width: 2560, height: 720 });
  // The MttVDD parser needs the full schema or it ignores the file and falls back
  // to its built-in 800x600 default.
  assert.match(xml, /<global>/);
  assert.match(xml, /<options>/);
  // All dropdown presets must be advertised so a later switch is a live mode-set.
  for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 720], [2560, 1440], [3440, 1440]]) {
    assert.match(xml, new RegExp(`<width>${w}</width>\\s*<height>${h}</height>`));
  }
  assert.match(xml, /<count>1<\/count>/); // still exactly one monitor
});
