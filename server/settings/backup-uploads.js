// Puts the uploaded background and the uploaded font into a backup, when they are small enough
// to travel.

const fs = require('node:fs');
const path = require('node:path');
const { FONT_MAX_BYTES } = require('../http/upload-limits.js');
const { UPLOADS_DIR } = require('../engine/uploads-dir.js');
const { BACKUP_BACKGROUND_MAX_BYTES, BACKUP_SAFE_NAME_RE } = require('./backup-format.js');

// The custom background binary, embedded as base64 when it is small enough
// (images; a 200MB video would dwarf the bundle — skipped, and the import then
// clears the dangling reference instead of leaving a broken background).
async function _buildBackupBackground(settings) {
  const bg = settings && settings.backgroundMedia;
  if (!bg || typeof bg !== 'object' || typeof bg.url !== 'string') return null;
  const fileName = bg.url.split('/').pop() || '';
  if (!BACKUP_SAFE_NAME_RE.test(fileName)) return null;
  try {
    const abs = path.join(UPLOADS_DIR, fileName);
    const st = await fs.promises.stat(abs);
    if (!st.isFile() || st.size > BACKUP_BACKGROUND_MAX_BYTES) return null;
    return { file: fileName, data: (await fs.promises.readFile(abs)).toString('base64') };
  } catch { return null; }
}

// The custom UI font binary, embedded as base64 (fonts are small — always well
// under FONT_MAX_BYTES — so, unlike large video backgrounds, they always travel).
async function _buildBackupFont(settings) {
  const font = settings && settings.uiFont;
  if (!font || typeof font !== 'object' || typeof font.url !== 'string') return null;
  const fileName = font.url.split('/').pop() || '';
  if (!BACKUP_SAFE_NAME_RE.test(fileName)) return null;
  try {
    const abs = path.join(UPLOADS_DIR, fileName);
    const st = await fs.promises.stat(abs);
    if (!st.isFile() || st.size > FONT_MAX_BYTES) return null;
    return { file: fileName, data: (await fs.promises.readFile(abs)).toString('base64') };
  } catch { return null; }
}

module.exports = { _buildBackupBackground, _buildBackupFont };
