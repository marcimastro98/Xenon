// Reads the settings file with every key checked, trying again while another program holds the
// file, and gives a write the settings to start from: the factory ones only when there is no
// file yet.
//
// A read of a file that has not changed is answered from memory. Some 90 places read the
// settings, a few of them every couple of seconds, and with custom themes the file is about
// 1.5 MB: reading, parsing and checking it cost about 7 ms and 10 MB of garbage each time,
// against 0.25 ms for a look at the file and a copy (measured 24 Nov 2026). Unchanged means the
// same file id, size and times (an atomic save puts a new file in place); a save made here
// forgets the kept copy anyway. Every caller gets a copy of its own, since callers change what
// they read before they save it; the copies share the strings, which never change.

const fs = require('node:fs');
const { _SETTINGS_READ_BUSY } = require('./store-file.js');
const { SETTINGS_FILE } = require('./settings-file.js');
const { DEFAULT_HUB_SETTINGS } = require('./defaults.js');
const { normalizeHubSettings } = require('./normalize-hub-settings.js');
const { settingsStore } = require('./store-state.js');

/** A copy of JSON-shaped data: objects and arrays new, strings and numbers shared. */
function copyJson(/** @type {any} */ v) {
  if (Array.isArray(v)) return v.map(copyJson);
  if (!v || typeof v !== 'object') return v;
  /** @type {Record<string, any>} */
  const o = {};
  for (const k of Object.keys(v)) {
    // A key named __proto__ (JSON.parse makes it an own key) must stay a key, not a prototype.
    if (k === '__proto__') Object.defineProperty(o, k, { value: copyJson(v[k]), enumerable: true, writable: true, configurable: true });
    else o[k] = copyJson(v[k]);
  }
  return o;
}

/** @param {fs.BigIntStats} st */
const fileSign = (st) => `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.birthtimeNs}`;

/**
 * @param {string} file @param {typeof fs.promises} [fsp]
 */
function createSettingsReader(file, fsp = fs.promises) {
  /** @type {{ sign: string, value: any } | null} */
  let kept = null;

  /** The checked settings, or null when there is no file. Throws when it cannot be read. */
  async function read() {
    for (let attempt = 0; ; attempt++) {
      try {
        const sign = fileSign(await fsp.stat(file, { bigint: true }));
        if (kept?.sign !== sign) {
          // Read after the look: a file replaced in between is newer than its sign, so the
          // next look reads it again.
          const value = normalizeHubSettings(JSON.parse(await fsp.readFile(file, 'utf8')));
          kept = { sign, value };
        }
        const parsed = copyJson(kept.value);
        if (parsed.storeId) settingsStore.id = parsed.storeId;
        return parsed;
      } catch (/** @type {any} */ e) {
        if (e.code === 'ENOENT') { kept = null; return null; }
        if (!_SETTINGS_READ_BUSY.has(e.code) || attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
      }
    }
  }
  return { read, forget: () => { kept = null; } };
}

const reader = createSettingsReader(SETTINGS_FILE);

async function readHubSettings() { return reader.read(); }

// For a read that a write is built on. Only a missing file (a new install)
// starts from the factory settings. Any other failure, a file that does not
// parse or a read that keeps failing, fails the write instead: these writers
// used to start from the factory settings whenever the read failed, and then
// saved that, which replaced everything the user had built with the default
// layout, theme and pages. POST /settings has always failed closed this way.
async function readHubSettingsForUpdate() {
  return (await readHubSettings()) || { ...DEFAULT_HUB_SETTINGS };
}

module.exports = { readHubSettings, readHubSettingsForUpdate, forgetReadSettings: reader.forget, createSettingsReader };
