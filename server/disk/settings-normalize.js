// Checks the saved settings of the Disk widget: the development folders and the age of old
// installers.

const { clampNumber } = require('../settings/values.js');

function normalizeDiskSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  const folders = Array.isArray(v.devFolders)
    ? v.devFolders
      .map((f) => String(f || '').trim().slice(0, 260))
      .filter((f) => /^[A-Za-z]:[\\/]/.test(f))
      .slice(0, 10)
    : [];
  return {
    devFolders: folders,
    installerAgeDays: clampNumber(v.installerAgeDays, 7, 365, 30),
  };
}

module.exports = { normalizeDiskSettings };
