// The collectors that read this machine where PowerShell cannot: the Linux ones, the macOS
// ones, or none on Windows.

// Non-Windows native collectors (GPU/disk/CPU-temp/network/windows/audio).
// Windows keeps the PowerShell path; elsewhere those spawns fail
// (powershell.exe ENOENT) so the system tiles fall back to these. Each module
// returns the SAME shapes the Windows collectors produced, so every consumer
// below is platform-agnostic. See linux-collectors.js / darwin-collectors.js.
const nativeCollectors =
  process.platform === 'linux' ? require('../linux-collectors.js') :
  process.platform === 'darwin' ? require('../darwin-collectors.js') : null;

module.exports = { nativeCollectors };
