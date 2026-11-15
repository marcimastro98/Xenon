'use strict';
// Where the iCUE SDK library is on this PC, and whether it is there at all.

const path = require('node:path');
const fs = require('node:fs');
const { bridge } = require('./bridge-state.js');
const SERVER_DIR = path.join(__dirname, '..');

// Resolve the SDK client DLL across installs. The redistributable client DLL is
// not always shipped under the Corsair path; an env override and a bundled copy
// take priority so the bridge is self-contained when possible.
const SDK_DLL_NAME = 'iCUESDK.x64_2019.dll';

// Every folder directly under the Corsair install root, newest first. iCUE has
// shipped under at least three different folder names ("CUE", "CORSAIR iCUE 5
// Software", "Corsair iCUE5 Software" as of 5.48) and hardcoding them meant the
// list silently rotted with each rename. Scanning the root survives the next one.
function corsairInstallCandidates() {
  const roots = ['C:\\Program Files\\Corsair', 'C:\\Program Files (x86)\\Corsair'];
  const out = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory()) out.push(path.join(root, e.name, SDK_DLL_NAME));
  }
  return out;
}

const DLL_PROBE_TTL_MS = 30000;

function resolveDllPath() {
  const now = Date.now();
  if (bridge.dllProbe.at && now - bridge.dllProbe.at < DLL_PROBE_TTL_MS) return bridge.dllProbe.path;
  const found = probeDllPath();
  bridge.dllProbe = { at: now, path: found };
  return found;
}

// Drops the memoized probe so the very next isAvailable() sees a DLL that was
// just fetched — without this the lighting page keeps saying "not installed" for
// up to DLL_PROBE_TTL_MS after the user pressed the button, which reads as a
// failed install.
function refreshAvailability() { bridge.dllProbe = { at: 0, path: null }; }

function probeDllPath() {
  const candidates = [
    process.env.ICUE_SDK_DLL,
    // Downloaded from Corsair's official release by install.ps1
    // (Install-ICueSdkIfNeeded). First because it is the only copy whose version
    // we pin; iCUE 5.48 installs no SDK DLL at all, so on most machines it is
    // also the ONLY copy. Never committed to the repo — the SDK EULA grants use,
    // not redistribution.
    path.join(SERVER_DIR, 'icue-sdk', SDK_DLL_NAME),
    path.join(SERVER_DIR, 'vendor', SDK_DLL_NAME),
    ...corsairInstallCandidates(),
    // Shipped incidentally by unrelated software. Last resort: it can be years
    // older than the running iCUE.
    'C:\\Program Files\\GIGABYTE\\Control Center\\Lib\\MBStorage\\' + SDK_DLL_NAME,
  ].filter(Boolean);
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

// SDK is "available" if its client DLL can be resolved — checkable without
// loading it, so the UI shows controls (and a working master toggle) even while
// the bridge is OFF. Loaded lib short-circuits the filesystem probe.
function isAvailable() { return !!bridge.lib || resolveDllPath() !== null; }

module.exports = {
  SDK_DLL_NAME, corsairInstallCandidates, DLL_PROBE_TTL_MS, resolveDllPath, refreshAvailability,
  probeDllPath, isAvailable,
};
