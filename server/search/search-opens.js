'use strict';
// What was opened from the search and how often, the signal results are ranked by: read once,
// written a moment after it changes, and shown as a summary.

const path = require('node:path');
const fs = require('node:fs');
const { writeFileAtomic } = require('../atomic-write.js');
const { USAGE_SAVE_DEBOUNCE_MS } = require('./search-limits.js');

function makeOpens({ usageFile, tally }) {
  async function loadUsage() {
    if (tally.usage) return tally.usage;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(usageFile, 'utf8'));
      tally.usage = {
        opens: (parsed && typeof parsed.opens === 'object' && parsed.opens) || {},
        folders: (parsed && typeof parsed.folders === 'object' && parsed.folders) || {},
      };
    } catch { tally.usage = { opens: {}, folders: {} }; }
    return tally.usage;
  }

  function scheduleUsageSave() {
    tally.usageDirty = true;
    if (tally.usageSaveTimer) return;
    tally.usageSaveTimer = setTimeout(() => {
      tally.usageSaveTimer = null;
      if (!tally.usage || !tally.usageDirty) return;
      tally.usageDirty = false;
      writeFileAtomic(usageFile, JSON.stringify(tally.usage)).catch(() => { tally.usageDirty = true; });
    }, USAGE_SAVE_DEBOUNCE_MS);
    tally.usageSaveTimer.unref();
  }

  // Read-only view of the usage log for the AI full-context mode (strict
  // opt-in in Settings): the folders the user opens results from and the most
  // recent opens, bounded. Names and dirs only — this is exactly the data the
  // user agreed to share with their AI provider, nothing more.
  async function usageSnapshot() {
    const u = await loadUsage();
    const opens = Object.entries(u.opens || {})
      .filter(([, rec]) => rec && Number.isFinite(rec.last))
      .sort((a, b) => b[1].last - a[1].last)
      .slice(0, 20)
      .map(([p, rec]) => ({ name: path.basename(p), dir: path.dirname(p), last: rec.last }));
    const folders = Object.entries(u.folders || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([dir]) => dir);
    return { opens, folders };
  }

  return { loadUsage, scheduleUsageSave, usageSnapshot };
}

module.exports = { makeOpens };
