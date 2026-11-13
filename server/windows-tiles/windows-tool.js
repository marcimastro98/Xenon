// Lists and moves the open windows: through the helper program when it is there, through the
// script otherwise.

const fs = require('node:fs');
const { nativeCollectors } = require('../system/native-collectors.js');
const { HELPER_EXE } = require('../engine/paths.js');
const { WINDOWS_SCRIPT } = require('./script-paths.js');
const { runPowerShellScript } = require('../powershell/run-command.js');
const { runHelperOneShot } = require('../system/helper-one-shot.js');

// App-switcher windows tool: prefer the native helper when the exe exists, fall
// back to windows.ps1 transparently on ANY helper problem (missing, crashed,
// bad output) — the PowerShell path is the permanent safety net.
async function runWindowsTool(args, timeout) {
  // The helper first, on every platform that has one. On macOS this is not
  // merely faster than the osascript collector: NSWorkspace needs no permission
  // at all, while Automation is granted per TARGET APPLICATION, so the
  // scripted list stays empty until the user has approved each app one by one.
  if (fs.existsSync(HELPER_EXE)) {
    try { return await runHelperOneShot(['windows', ...args], timeout); }
    catch { /* fall through to the platform's own path */ }
  }
  if (nativeCollectors) return nativeCollectors.windows(args[0], args[1]);
  return runPowerShellScript(WINDOWS_SCRIPT, args, timeout);
}

module.exports = { runWindowsTool };
