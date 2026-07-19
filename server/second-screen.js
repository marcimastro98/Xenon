'use strict';

// Second-screen feature — prerequisite check + one-click setup of its only external
// dependency: a virtual display driver (VDD). The capture/encode pipeline lives in
// the Xenon Helper, which is already distributed one-click via the signed CI release,
// so there is nothing else to fetch.
//
// Setup has two distinct steps (confirmed by the on-machine spike):
//   1. INSTALL the driver files — `winget install VirtualDrivers.Virtual-Display-Driver`
//      (silent, signed; no device dialog, no reboot on the test machine).
//   2. CREATE a virtual display — the install alone does NOT add a monitor. The VDD's
//      control app does it with the bundled `devcon.exe` against the signed
//      `MttVDD.inf` (hardware id `Root\MttVDD`) plus a `vdd_settings.xml` config
//      copied to `C:\VirtualDisplayDriver\`. We replicate that headlessly.
//
// Philosophy (one-click-or-explain): automate what we can; for anything that can't be
// automated (winget missing, a Windows device-install prompt, a reboot) return a
// stable `code` the UI turns into a clear, step-by-step explanation. Never a dead end.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const defaultRunner = require('./remote-control/runner');
const { createInstaller } = require('./remote-control/installer');

// devcon usa exit code propri: 0 = fatto, 1 = fatto ma serve un riavvio, 2 =
// fallito, 3 = errore di sintassi. `runElevated` riporta l'exit code reale del
// processo elevato, quindi 1 va letto come successo o il setup segnalerebbe un
// errore proprio quando ha funzionato.
const DEVCON_OK = new Set([0, 1]);
const devconOk = (r) => !!(r && DEVCON_OK.has(r.code));

const VDD_HWID = 'Root\\MttVDD';
const CONFIG_DIR = 'C:\\VirtualDisplayDriver';
const CONFIG_PATH = path.join(CONFIG_DIR, 'vdd_settings.xml');

// The resolutions offered in Settings → Second screen. The config advertises ALL
// of them (plus whatever specific mode is requested) so switching resolution later
// is a live mode-set (helper `setmode` → ChangeDisplaySettingsEx) with NO driver
// reinstall — only the very first setup needs the elevated devcon step.
const PRESET_RESOLUTIONS = [
  [1280, 720], [1920, 1080], [2560, 720], [2560, 1440], [3440, 1440],
];

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// Build the driver config: one monitor advertising every preset resolution. The
// MttVDD parser needs the FULL schema (incl. <global>/<options>) — a partial file
// is silently ignored and the driver falls back to its built-in 800x600 default,
// which is exactly the "stuck small with side bars" bug. Keep this matching the
// schema shipped in the VDD package's Dependencies/vdd_settings.xml.
function buildConfigXml(mode = {}) {
  const w = clampInt(mode.width, 640, 7680, 1920);
  const h = clampInt(mode.height, 480, 4320, 1080);
  const r = clampInt(mode.refresh, 30, 244, 60);

  // Presets + the requested mode, de-duplicated (the requested one may match a preset).
  const set = new Map();
  for (const [pw, ph] of PRESET_RESOLUTIONS) set.set(pw + 'x' + ph, [pw, ph]);
  set.set(w + 'x' + h, [w, h]);
  const resolutions = [...set.values()].map(([rw, rh]) => [
    '        <resolution>',
    `            <width>${rw}</width>`,
    `            <height>${rh}</height>`,
    `            <refresh_rate>${r}</refresh_rate>`,
    '        </resolution>',
  ].join('\n')).join('\n');

  return [
    "<?xml version='1.0' encoding='utf-8'?>",
    '<vdd_settings>',
    '    <monitors>',
    '        <count>1</count>',
    '    </monitors>',
    '    <gpu>',
    '        <friendlyname>default</friendlyname>',
    '    </gpu>',
    '    <global>',
    `        <g_refresh_rate>${r}</g_refresh_rate>`,
    '    </global>',
    '    <resolutions>',
    resolutions,
    '    </resolutions>',
    '    <options>',
    '        <HardwareCursor>true</HardwareCursor>',
    '        <logging>false</logging>',
    '    </options>',
    '</vdd_settings>',
    '',
  ].join('\n');
}

// Locate the winget-installed VDD package dir (version-independent): its folder name
// starts with the package id under the WinGet Packages store.
function defaultFindPackageDir() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  let entries = [];
  try { entries = fs.readdirSync(base); } catch { return ''; }
  const hit = entries.find((n) => n.startsWith('VirtualDrivers.Virtual-Display-Driver_'));
  return hit ? path.join(base, hit) : '';
}

// Each prerequisite/step is { id, ok, action, code? } where `action` is:
//   'none'    — satisfied
//   'install' — we can auto-install/create it (the UI shows a one-click button)
//   'manual'  — can't be automated; the UI must explain `code` to the user
function createSecondScreen({
  installer,
  runner = defaultRunner,
  findPackageDir = defaultFindPackageDir,
  writeConfig,
  probeDisplayActive,
} = {}) {
  const inst = installer || createInstaller({ runner });

  const doWriteConfig = writeConfig || ((xml) => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, xml, 'utf8');
  });

  // Is a virtual display device actually present (vs. just the driver files)?
  const isDisplayActive = probeDisplayActive || (async () => {
    const r = await runner.run('powershell', [
      '-NoProfile', '-Command',
      "(Get-PnpDevice -Class Display -PresentOnly -EA SilentlyContinue | " +
      "Where-Object { $_.FriendlyName -match 'Virtual Display Driver' -and $_.Status -eq 'OK' } | " +
      'Measure-Object).Count',
    ]);
    return !!(r && r.code === 0 && parseInt(String(r.stdout).trim(), 10) > 0);
  });

  async function requirements() {
    const wingetAvailable = await inst.isWingetAvailable();
    if (!wingetAvailable) {
      return {
        ready: false, wingetAvailable: false, vddInstalled: false, displayActive: false,
        steps: [{ id: 'winget', ok: false, action: 'manual', code: 'winget_missing' }],
      };
    }

    const vddInstalled = await inst.isInstalled('vdd');
    if (!vddInstalled) {
      return {
        ready: false, wingetAvailable: true, vddInstalled: false, displayActive: false,
        steps: [
          { id: 'winget', ok: true, action: 'none' },
          { id: 'vdd', ok: false, action: 'install', code: 'vdd_missing' },
          { id: 'display', ok: false, action: 'install', code: 'display_missing' },
        ],
      };
    }

    const displayActive = await isDisplayActive();
    return {
      ready: displayActive,
      wingetAvailable: true,
      vddInstalled: true,
      displayActive,
      steps: [
        { id: 'winget', ok: true, action: 'none' },
        { id: 'vdd', ok: true, action: 'none' },
        displayActive
          ? { id: 'display', ok: true, action: 'none' }
          : { id: 'display', ok: false, action: 'install', code: 'display_missing' },
      ],
    };
  }

  // One-click install of the virtual display driver files. Returns a structured
  // result (never throws on the expected "can't automate" path).
  async function installDriver() {
    if (!(await inst.isWingetAvailable())) {
      return { ok: false, action: 'manual', code: 'winget_missing' };
    }
    const r = await inst.install('vdd');
    if (r && r.code === defaultRunner.UAC_CANCELLED) {
      return { ok: false, action: 'retry', code: 'vdd_install_declined', raw: r };
    }
    // L'exit code di winget e' solo un indizio (restituisce non-zero anche per
    // "gia' installato" o "serve un riavvio"): la verita' e' se il pacchetto ora
    // c'e'. Ricontrolliamo lo stato invece di dichiarare un fallimento falso.
    if (await inst.isInstalled('vdd')) {
      return { ok: true, action: 'next', code: 'vdd_installed', raw: r };
    }
    return { ok: false, action: 'retry', code: 'vdd_install_failed', raw: r };
  }

  // Create (or re-apply the config of) THE virtual display: write the config,
  // then drive the package's bundled devcon against its signed INF. Elevated (UAC).
  //
  // CRITICAL — exactly one monitor, always: `devcon install` creates a NEW device
  // node on every call, so calling it repeatedly spams extra (and, after a reboot,
  // persistent "dead") monitors and scrambles the user's real display layout. So
  // we ALWAYS remove any existing Root\MttVDD devnodes first — which also
  // self-heals a machine that already has duplicates — then install a single
  // instance that reads the config we just wrote. Re-applying a resolution goes
  // through the same path, guaranteeing the count can never grow.
  async function createDisplay(mode) {
    const dir = findPackageDir();
    if (!dir) return { ok: false, action: 'retry', code: 'vdd_files_missing' };
    const devcon = path.join(dir, 'Dependencies', 'devcon.exe');
    const inf = path.join(dir, 'SignedDrivers', 'x86', 'VDD', 'MttVDD.inf');

    try { doWriteConfig(buildConfigXml(mode || {})); }
    catch (e) { return { ok: false, action: 'manual', code: 'config_write_failed', error: e.message }; }

    // Clear any/all existing instances first (no-op if none) so we never stack.
    await runner.runElevated(devcon, ['remove', VDD_HWID]);
    const r = await runner.runElevated(devcon, ['install', inf, VDD_HWID]);
    if (r && r.code === defaultRunner.UAC_CANCELLED) {
      return { ok: false, action: 'retry', code: 'display_create_declined', raw: r };
    }
    if (!devconOk(r)) return { ok: false, action: 'retry', code: 'display_create_failed', raw: r };
    // A fresh device node may not be enumerated yet; if so a reboot resolves it —
    // surface that rather than appearing broken.
    const active = await isDisplayActive();
    return active
      ? { ok: true, action: 'none', code: 'display_ready', raw: r }
      : { ok: true, action: 'reboot_maybe', code: 'display_needs_reboot', raw: r };
  }

  // Remove the virtual display (used when disabling the feature / cleanup).
  async function removeDisplay() {
    const dir = findPackageDir();
    if (!dir) return { ok: false, code: 'vdd_files_missing' };
    const devcon = path.join(dir, 'Dependencies', 'devcon.exe');
    const r = await runner.runElevated(devcon, ['remove', VDD_HWID]);
    return { ok: devconOk(r), raw: r };
  }

  return { requirements, installDriver, createDisplay, removeDisplay, buildConfigXml };
}

module.exports = { createSecondScreen, buildConfigXml, VDD_HWID, CONFIG_PATH };
