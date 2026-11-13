// Reads the volume of every device and app: from the system's own reader where there is one,
// from SoundVolumeView on Windows.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { nativeCollectors } = require('../system/native-collectors.js');
const { makeCsvPath, parseCsvLine } = require('./svv-csv.js');
const { SVV } = require('./svv-path.js');
const svvText = require('../svv-text.js');

function readSoundVolumeRows() {
  if (nativeCollectors) return nativeCollectors.audioRows();
  return new Promise((resolve, reject) => {
    const csv = makeCsvPath();
    // UTF-8 asked for explicitly and decoded by what arrived (svv-text.js): read
    // as latin1, "Kopfhörer" became "KopfhÃ¶rer" and switching to it did nothing
    // (issue #145).
    execFile(SVV, [...svvText.UTF8_EXPORT, '/scomma', csv, '/AvoidPrompts'], { timeout: 6000 }, err => {
      if (err) { fs.unlink(csv, () => {}); return reject(err); }
      setTimeout(async () => {
        try {
          const raw = svvText.decodeCsv(await fs.promises.readFile(csv));
          const rows = raw
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .map(parseCsvLine);
          fs.unlink(csv, () => {});
          resolve(rows);
        } catch (e) {
          fs.unlink(csv, () => {});
          reject(e);
        }
      }, 250);
    });
  });
}

function readSoundingRows() {
  if (!nativeCollectors) return readSoundVolumeRows();
  // macOS rows name devices only: there is no per-app sound to read there.
  return nativeCollectors.soundingRows ? nativeCollectors.soundingRows() : Promise.resolve([]);
}

module.exports = { readSoundVolumeRows, readSoundingRows };
