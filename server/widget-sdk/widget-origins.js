// Where each installed widget came from and which version of the Store it was, read once from
// its file when the engine starts and never on a request.

const fs = require('node:fs');
const { WIDGET_ORIGINS_FILE } = require('./data-places.js');

const _widgetOrigins = (() => {   // one small read at startup, never on a request
  try {
    const raw = JSON.parse(fs.readFileSync(WIDGET_ORIGINS_FILE, 'utf8'));
    const out = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const id of Object.keys(raw)) {
        const rec = raw[id];
        if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) continue;
        if (!rec || !['import', 'creator', 'builtin', 'local'].includes(rec.origin)) continue;
        out[id] = {
          origin: rec.origin,
          at: typeof rec.at === 'string' ? rec.at.slice(0, 32) : '',
          // Which CATALOG version this package was last installed from — see
          // recordWidgetOrigin. Same charset the SDK accepts for a version.
          catalogVersion: (typeof rec.catalogVersion === 'string' && /^[0-9A-Za-z._+-]{1,32}$/.test(rec.catalogVersion))
            ? rec.catalogVersion : '',
        };
      }
    }
    return out;
  } catch { return {}; }   // missing/corrupt → everything defaults to 'unknown'
})();

module.exports = { _widgetOrigins };
