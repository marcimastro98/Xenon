// Small checks used when looking for ffmpeg: finding a file by name under a folder, and
// recognising the "not installed" error.

const fs = require('node:fs');
const path = require('node:path');

function findFirstFile(root, fileName, maxDepth) {
  if (!root || maxDepth < 0 || !fs.existsSync(root)) return null;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const direct = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase());
    if (direct) return path.join(root, direct.name);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = findFirstFile(path.join(root, entry.name), fileName, maxDepth - 1);
      if (found) return found;
    }
  } catch {}
  return null;
}

function isFfmpegMissing(error) {
  return error && (error.code === 'ENOENT' || /not recognized|ENOENT|cannot find/i.test(String(error.message || '')));
}

module.exports = { findFirstFile, isFfmpegMissing };
