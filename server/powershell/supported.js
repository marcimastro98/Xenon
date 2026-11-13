// Whether this system has PowerShell: every PowerShell path of the engine asks here first and
// answers unavailable elsewhere.

// Every PowerShell path in this file is gated on this. The collectors above
// cover the sensors, but dozens of on-demand features (Deck actions, RAM
// detail, window management, the media host) still shell out to a .ps1, and
// off Windows those spawns fail with ENOENT several layers below the caller.
// Rejecting once, here, turns "a stack of ENOENT noise per click" into the
// clean per-feature "unavailable" the action registry already knows how to
// render. See runPowerShellScript / runPowerShellCommand.
const POWERSHELL_SUPPORTED = process.platform === 'win32';

module.exports = { POWERSHELL_SUPPORTED };
