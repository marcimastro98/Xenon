// Deletes the uploaded backgrounds and fonts that a newer upload replaced, so one of each is
// kept.

const fs = require('node:fs');
const path = require('node:path');
const { UPLOADS_DIR } = require('../engine/uploads-dir.js');

function cleanupOldBackgrounds(keepName) {
  fs.promises.readdir(UPLOADS_DIR).then(files => Promise.all(files
    .filter(file => file.startsWith('background-') && file !== keepName)
    .map(file => fs.promises.unlink(path.join(UPLOADS_DIR, file)).catch(() => {}))
  )).catch(() => {});
}

// Same one-live-file policy as backgrounds: a fresh upload/restore leaves exactly
// one `font-*` in UPLOADS_DIR, so orphaned fonts never accumulate.
function cleanupOldFonts(keepName) {
  fs.promises.readdir(UPLOADS_DIR).then(files => Promise.all(files
    .filter(file => file.startsWith('font-') && file !== keepName)
    .map(file => fs.promises.unlink(path.join(UPLOADS_DIR, file)).catch(() => {}))
  )).catch(() => {});
}

module.exports = { cleanupOldBackgrounds, cleanupOldFonts };
