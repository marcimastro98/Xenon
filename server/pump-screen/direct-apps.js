'use strict';
// Which program holds a pump screen now: two programs drawing on one screen draw over each
// other, so Xenon draws only while none of the screen's own programs runs (the panel's
// `holders`), and never closes one. Windows reads the process table in one native call
// (perf-session/process-table-windows.js: nothing is started, and this runs every few seconds
// while Xenon draws); a table that cannot be read falls back to tasklist through
// airflow/link-busy.js, as Linux does (OpenLinkHub). A check that cannot run counts as busy.

const NAMES = Object.freeze({ icue: 'iCUE', openlinkhub: 'OpenLinkHub' });

const shown = (name) => NAMES[String(name).toLowerCase().replace(/\.exe$/, '')] || String(name).replace(/\.exe$/i, '');

/**
 * @param {{ platform?: string, table?: { read: () => Promise<Array<{ name: string }> | null> } | null,
 *   fallback?: () => Promise<string[]> }} [o]
 * @returns {(panel: { holders?: Record<string, readonly string[]> }) => Promise<string[]>} the programs in the way
 */
function createPumpApps({ platform = process.platform, table, fallback } = {}) {
  const rows = table !== undefined ? table
    : platform === 'win32' ? require('../perf-session/process-table-windows.js').createWindowsProcessTable() : null;
  const busy = fallback || require('../airflow/link-busy.js').createLinkBusy({ platform });

  return async function holding(panel) {
    const wanted = panel?.holders?.[platform] || [];
    if (!wanted.length) return [];
    const list = rows ? await rows.read() : null;
    if (list) return wanted.filter((app) => list.some((r) => r.name === app)).map(shown);
    return (await busy()).map(shown);
  };
}

module.exports = { createPumpApps };
