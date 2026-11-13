// Reads the table SoundVolumeView writes: the column numbers, one line split into fields, and a
// temporary file to write it to.

const os = require('node:os');
const path = require('node:path');

// CSV column indices for SoundVolumeView /scomma (no header row)
const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18, PROC_PATH: 19, PROC_ID: 20, WINDOW_TITLE: 21 };

function makeCsvPath() {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `xenonedge-svv-${stamp}.csv`);
}

function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; }
    else { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

module.exports = { F, makeCsvPath, parseCsvLine };
