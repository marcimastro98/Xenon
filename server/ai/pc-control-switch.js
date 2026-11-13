// Whether Xenon AI may act on this PC: the user's switch, and only where PowerShell exists.

const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { hub } = require('../settings/current.js');

// PC Control is a PowerShell feature, not merely a Windows-first one: the
// command the AI writes is PowerShell, the confirmation card shows the user
// PowerShell, and the runner below spawns it directly rather than through
// runPowerShellScript — so it is the one place POWERSHELL_SUPPORTED does not
// already answer for. Off Windows it therefore reports itself disabled at both
// gates and is never offered to the model, instead of proposing a command,
// getting the user to approve it, and failing with a spawn ENOENT. Turning it
// on elsewhere means giving the AI a POSIX shell, which is a product decision
// about a much larger blast radius, not a translation of this code.
function _pcControlEnabled() {
  if (!POWERSHELL_SUPPORTED) return false;
  const f = hub.settings && hub.settings.aiFeatures;
  return !!(f && f.enabled === true && f.pcControl === true);
}

module.exports = { _pcControlEnabled };
