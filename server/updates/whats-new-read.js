// Reads the What's New text of this version from disk, at most once a minute.

const fs = require('node:fs');
const { WHATSNEW_FILE } = require('./whats-new-file.js');
const { normalizeWhatsNew } = require('./whats-new-normalize.js');
const { whatsNewRead } = require('./whats-new-state.js');

async function loadWhatsNew() {
  const now = Date.now();
  if (whatsNewRead.cache && now - whatsNewRead.cache.at < 60 * 1000) return whatsNewRead.cache.data;
  let data = { id: '', title: '', url: '', highlights: [] };
  try {
    data = normalizeWhatsNew(JSON.parse(await fs.promises.readFile(WHATSNEW_FILE, 'utf8')));
  } catch { /* missing/invalid → empty: the modal simply won't show */ }
  whatsNewRead.cache = { at: now, data };
  return data;
}

module.exports = { loadWhatsNew };
