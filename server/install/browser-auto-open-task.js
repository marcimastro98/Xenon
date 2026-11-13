// The Windows task that opens the dashboard in a browser at sign-in: reads its state, registers
// or removes it, and repairs one that points at a script that is gone.

const fs = require('node:fs');
const { runPowerShellCommand } = require('../powershell/run-command.js');
const { OPEN_DASHBOARD_VBS } = require('./launcher-paths.js');
const { AUTO_OPEN_SUPPORTED, autoOpenTaskFix } = require('./browser-auto-open.js');
const { psEscape } = require('../ps-quote.js');

// ── "Open dashboard in browser at logon" task ────────────────────────────────
// A per-user Scheduled Task ("Xenon Edge Dashboard") that runs open-dashboard.vbs
// at logon. The server already auto-starts at logon via its own task; this one
// just opens the browser tab for people who use the dashboard in a real browser
// (Xeneon Edge loads the iframe itself, so it never wants this). Registered on
// demand from the client and reflected back so the toggle shows the true state.
//
// The task outlives the file it points at, and that asymmetry is the whole bug
// behind the "Can not find script file ...\server\open-dashboard.vbs" box some
// people meet at every single logon while Xenon itself starts perfectly well:
// Windows keeps running the task, wscript.exe finds nothing at the path, and
// says so in a modal nobody can act on. Two things put the pair out of step —
// the install root moving (the engine lives in %LOCALAPPDATA%\Programs\Xenon
// now, and a task registered by an older layout still carries the old one), and
// the script no longer being on disk at all, a .vbs run at logon being textbook
// antivirus bait for an unsigned project. So the task is reconciled against the
// disk at boot: repointed when the path is stale, removed when there is no
// launcher left for it to point at.
const BROWSER_TASK_NAME = 'Xenon Edge Dashboard';

// Doubles every quote PowerShell ends a single-quoted string on (ps-quote.js).
function psSingleQuote(value) {
  return psEscape(value);
}

// Is the launcher this feature needs still on disk?
function openDashboardLauncherPresent() {
  try { return fs.existsSync(OPEN_DASHBOARD_VBS); } catch { return false; }
}

// Returns { enabled, launcher, taskScript }. `enabled` is the state worth
// reporting to the dashboard — the task exists AND the script it runs is there —
// so the toggle can no longer sit on "on" for a task that only raises an error.
async function getBrowserAutoOpenState() {
  if (!AUTO_OPEN_SUPPORTED) return { enabled: false, launcher: 'ok', taskScript: '' };
  const launcher = openDashboardLauncherPresent() ? 'ok' : 'missing';
  const cmd =
    `$t = Get-ScheduledTask -TaskName '${psSingleQuote(BROWSER_TASK_NAME)}' -ErrorAction SilentlyContinue; ` +
    `$arg = ''; if ($t) { $a = @($t.Actions)[0]; if ($a) { $arg = [string]$a.Arguments } } ` +
    `Write-Output (@{ ok = $true; enabled = [bool]$t; argument = $arg } | ConvertTo-Json -Compress)`;
  try {
    const out = await runPowerShellCommand(cmd, 8000);
    const exists = !!(out && out.enabled === true);
    return { enabled: exists && launcher === 'ok', launcher, taskScript: (out && out.argument) || '' };
  } catch {
    return { enabled: false, launcher, taskScript: '' };
  }
}

// Registers (enabled) or removes the logon task. Returns { enabled }, plus a
// `reason` when the request could not be honoured.
async function setBrowserAutoOpen(enabled) {
  if (!AUTO_OPEN_SUPPORTED) return { enabled: false };
  // Registering a task for a script that is not there buys an error box at every
  // logon and nothing else. Refuse, and name the reason so the dashboard can stop
  // asking for it instead of re-posting the same request on every page load.
  if (enabled === true && !openDashboardLauncherPresent()) {
    return { enabled: false, reason: 'launcher_missing' };
  }
  let cmd;
  if (enabled) {
    const vbs = psSingleQuote(OPEN_DASHBOARD_VBS);
    cmd =
      `$ErrorActionPreference = 'Stop'; ` +
      `try { ` +
        `$wscript = Join-Path $env:WINDIR 'System32\\wscript.exe'; ` +
        `$user = "$env:USERDOMAIN\\$env:USERNAME"; ` +
        `$action = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + '${vbs}' + '"'); ` +
        `$trigger = New-ScheduledTaskTrigger -AtLogon -User $user; ` +
        // Interactive + Limited so the browser opens in the user's visible session
        // (a SYSTEM/Highest task would open invisibly in session 0).
        `$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited; ` +
        `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero); ` +
        `Register-ScheduledTask -TaskName '${psSingleQuote(BROWSER_TASK_NAME)}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null; ` +
        `Write-Output '{"ok":true,"enabled":true}' ` +
      `} catch { Write-Output (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress) }`;
  } else {
    cmd =
      `try { Unregister-ScheduledTask -TaskName '${psSingleQuote(BROWSER_TASK_NAME)}' -Confirm:$false -ErrorAction SilentlyContinue } catch { }; ` +
      `Write-Output '{"ok":true,"enabled":false}'`;
  }
  const out = await runPowerShellCommand(cmd, 12000);
  if (out && out.ok === false) throw new Error(out.error || 'Task registration failed');
  return { enabled: enabled === true };
}

// Bring the logon task in line with what is actually on disk. Called once at
// boot; silent and free when there is nothing to fix, which is the normal case.
// Note this can only take effect from the NEXT logon: by the time the server is
// up, the task has already run for this one.
async function reconcileBrowserAutoOpenTask() {
  if (!AUTO_OPEN_SUPPORTED) return;
  const state = await getBrowserAutoOpenState();
  const fix = autoOpenTaskFix({
    taskScript: state.taskScript,
    scriptPath: OPEN_DASHBOARD_VBS,
    launcherPresent: state.launcher === 'ok',
  });
  if (fix === 'none') return;
  if (fix === 'repair') {
    await setBrowserAutoOpen(true);
    console.log('[startup] browser auto-open task repointed at ' + OPEN_DASHBOARD_VBS);
    return;
  }
  await setBrowserAutoOpen(false);
  console.log('[startup] browser auto-open task removed: ' + OPEN_DASHBOARD_VBS + ' is missing');
}

module.exports = {
  BROWSER_TASK_NAME, psSingleQuote, openDashboardLauncherPresent, getBrowserAutoOpenState,
  setBrowserAutoOpen, reconcileBrowserAutoOpenTask,
};
