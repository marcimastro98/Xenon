// Shapes the drive details: PowerShell rows as a list, and volumes joined with the names of
// their disks.

// ConvertTo-Json turns a one-element array into a bare object, so both parsers
// re-wrap before iterating.
function psRows(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function joinDiskDetails(volumes, models) {
  const out = {};
  Object.keys(volumes).forEach(drive => {
    out[drive] = { ...volumes[drive], model: models[drive] || '' };
  });
  return out;
}

module.exports = { psRows, joinDiskDetails };
