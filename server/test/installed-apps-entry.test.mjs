// Whether Windows knows Xenon is installed — and whether the way out it offers
// actually goes anywhere.
//
// Xenon installs from a folder, not through an MSI, so nothing put it in
// Settings > Apps > Installed apps. The only uninstaller was UNINSTALL.bat back
// inside the folder, and someone who does not know it exists deletes the folder
// instead. That takes the files and leaves every footprint outside them — above
// all the per-logon scheduled tasks, which keep firing at scripts that are gone:
// "Can not find script file ...\server\open-dashboard.vbs", in a modal, at every
// sign-in, on a machine with no Xenon left on it to explain the box. Reported on
// Discord (Sep 2026) from a 4.0.0 folder run straight out of Downloads.
//
// The registry entry install.ps1 writes and the one uninstall.ps1 removes are
// two string literals in two files that nothing else connects. Drift either way
// is silent and only shows up on a real Windows machine: a leftover Uninstall
// button pointing into a deleted folder, or no entry at all and we are back to
// the bug. Same for the task NAMES — the uninstaller must remove exactly the
// tasks the installer and the server register.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const path = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const INSTALL = read('../install.ps1');
const UNINSTALL = read('../uninstall.ps1');
const SERVER = read('../server.js');
const README = read('../../README.md');
const CHANGELOG = read('../../CHANGELOG.md');

// The Uninstall key path, taken from install.ps1 rather than typed here, so this
// file cannot be the thing that is right while the installer is wrong.
const KEY = (() => {
  const m = INSTALL.match(/\$uninstallKey\s*=\s*'([^']+)'/);
  assert.ok(m, 'install.ps1 no longer defines $uninstallKey');
  return m[1];
})();

test('the Uninstall key is per-user and named apart from the kiosk NSIS entry', () => {
  assert.match(KEY, /^HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\/);
  const leaf = KEY.split('\\').pop();
  // The Tauri bundle owns ...\Uninstall\Xenon. Taking that name would have us
  // overwrite the kiosk's own entry, and its uninstaller would then delete ours.
  assert.notEqual(leaf, 'Xenon');
});

test('install.ps1 registers the entry, and does so in the main flow', () => {
  assert.match(INSTALL, /function Register-UninstallEntry\b/);
  // Defined is not called: the function existing proves nothing about installs.
  const calls = INSTALL.split('\n').filter((l) => /^Register-UninstallEntry\s*$/.test(l.trim()));
  assert.equal(calls.length, 1);
});

test('uninstall.ps1 removes the exact key install.ps1 writes', () => {
  assert.ok(
    UNINSTALL.includes(`'${KEY}'`),
    `uninstall.ps1 does not remove ${KEY} — an uninstalled Xenon would keep a dead Uninstall button`,
  );
  // As a key, not a single value: the entry is a whole subkey of its own.
  const line = UNINSTALL.split('\n').find((l) => l.includes(`'${KEY}'`));
  assert.match(line, /^Remove-RegItem\b/);
});

test('the Uninstall button points at a file that is actually shipped', () => {
  const m = INSTALL.match(/UninstallString\s*=\s*\('"\{0\}"'\s*-f\s*\$bat\)/);
  assert.ok(m, 'UninstallString is no longer the quoted $bat path');
  assert.match(INSTALL, /\$bat\s*=\s*Join-Path \$root 'UNINSTALL\.bat'/);
  assert.ok(existsSync(path('../../UNINSTALL.bat')), 'UNINSTALL.bat is missing from the repo root');
  // No entry at all beats an entry whose button does nothing.
  assert.match(INSTALL, /if \(-not \(Test-Path -LiteralPath \$bat\)\) \{[\s\S]{0,400}?return\n\s*\}/);
});

test('the quiet uninstall uses a switch uninstall.ps1 really has', () => {
  const m = INSTALL.match(/QuietUninstallString'\]\s*=\s*\('([^']+)'/);
  assert.ok(m, 'no QuietUninstallString');
  const switches = m[1].match(/\s-([A-Za-z]+)\b/g).map((s) => s.trim().slice(1));
  for (const sw of switches) {
    if (sw === 'NoProfile' || sw === 'ExecutionPolicy' || sw === 'File') continue;
    assert.match(UNINSTALL, new RegExp(`\\[switch\\]\\$${sw}\\b`), `uninstall.ps1 has no -${sw}`);
  }
  // Windows' own Uninstall button must not stop at a confirmation prompt in a
  // console the user never opened.
  assert.ok(switches.includes('Yes'));
});

test('the icon candidates exist in the release tree', () => {
  const block = INSTALL.slice(INSTALL.indexOf('function Register-UninstallEntry'));
  const m = block.match(/Join-Path \$root '([^']*\.ico)'/);
  assert.ok(m, 'no repo-relative icon candidate');
  assert.ok(existsSync(path(`../../${m[1].replace(/\\/g, '/')}`)), `${m[1]} is not in the repo`);
});

test('the uninstaller removes every logon task anything registers', () => {
  const removed = new Set(
    [...UNINSTALL.matchAll(/^Remove-TaskSafe '([^']+)'/gm)].map((m) => m[1]),
  );
  // $appName is passed by variable, not by literal, in the same list.
  assert.match(UNINSTALL, /^Remove-TaskSafe \$appName$/m);
  const appName = UNINSTALL.match(/\$appName\s*=\s*'([^']+)'/)[1];
  removed.add(appName);

  // The engine's own task, from install.ps1 …
  assert.equal(INSTALL.match(/\$appName\s*=\s*'([^']+)'/)[1], appName);
  // … and the optional browser one, registered by the server at runtime.
  const browser = SERVER.match(/const BROWSER_TASK_NAME\s*=\s*'([^']+)'/)[1];
  assert.ok(removed.has(browser), `uninstall.ps1 leaves the "${browser}" task behind`);
});

test('the docs say how to clear the leftovers on a folder that is already gone', () => {
  // Nothing on the machine can self-heal once the folder is deleted: the engine
  // that repoints the task is inside the folder. The docs are the only fix left.
  assert.match(README, /Unregister-ScheduledTask -TaskName 'Xenon Edge Widget'/);
  assert.match(README, /Unregister-ScheduledTask -TaskName 'Xenon Edge Dashboard'/);
  assert.match(README, /Installed apps/);
  assert.match(CHANGELOG, /Installed apps/);
});
