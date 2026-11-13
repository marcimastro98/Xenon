// Reads a JSON file that must hold a plain object, and answers an empty one when it is missing
// or damaged.

const fs = require('node:fs');

function readJsonMapSync(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch { return {}; }
}

module.exports = { readJsonMapSync };
