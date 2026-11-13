// What the engine answers for the Deck: its sounds, the icon of a program, the Store apps a key
// can open, the saved Deck, the states scripts set and whether the page shortcuts are held.

const { readBodyBuffer, readBody } = require('../http/read-body.js');
const { DECK_SOUND_MAX_BYTES, DECK_SOUND_EXTS, DECK_SOUND_NAME_RE } = require('./limits.js');
const { parseMultipartBackground } = require('../http/multipart-upload.js');
const path = require('node:path');
const fs = require('node:fs');
const { DECK_SOUNDS_DIR } = require('./pack-places.js');
const { execFile } = require('node:child_process');
const { resolveStoreAppIcon, resolveAppIcons } = require('../programs/app-icons.js');
const { isNetworkPath } = require('../files/network-path.js');
const { readDeckStore } = require('./store-read.js');
const { _hotkey } = require('./hotkey-state.js');
const { _deckShortcutStatus } = require('./shortcut-questions.js');
const { _altGrKeys } = require('./altgr-keys.js');
const { setScriptState, _scriptStates } = require('./script-states.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'POST /deck/sound-upload': async (req, res, { json }) => {
    // Soundboard library upload: store the clip under DATA_DIR/sounds with a
    // SERVER-GENERATED name (the client filename never reaches the path — same
    // shape as /background). Playback still flows through /deck/sound?path=,
    // which stays the single extension-gated reader of audio contents.
    try {
      const body = await readBodyBuffer(req, DECK_SOUND_MAX_BYTES);
      const file = parseMultipartBackground(req, body, 'sound');
      const ext = path.extname(file.originalName).toLowerCase();
      if (!DECK_SOUND_EXTS.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      // MIME consistency check, same shape as /background: a declared non-audio
      // content type must not land under an audio extension. Browsers report
      // audio types inconsistently, so only an explicit NON-audio type rejects
      // (octet-stream/empty pass — the extension allowlist stays the real gate).
      const ct = String(file.contentType || '').toLowerCase();
      if (ct && ct !== 'application/octet-stream' && !ct.startsWith('audio/') && ct !== 'video/webm') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File type mismatch' }));
        return;
      }
      await fs.promises.mkdir(DECK_SOUNDS_DIR, { recursive: true });
      const safeName = `sound-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      const safePath = path.join(DECK_SOUNDS_DIR, safeName);
      await fs.promises.writeFile(safePath, file.data);
      json({ ok: true, path: safePath, name: file.originalName, size: file.data.length });
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
  },

  'GET /deck/sounds': async (_req, _res, { json, err500 }) => {
    // The uploaded soundboard library (for the editor's sound picker).
    try {
      let entries = [];
      try { entries = await fs.promises.readdir(DECK_SOUNDS_DIR, { withFileTypes: true }); } catch { /* none yet */ }
      const names = entries.filter((ent) => ent.isFile() && DECK_SOUND_NAME_RE.test(ent.name)).map((ent) => ent.name);
      // Stat in parallel — a large library shouldn't pay the sum of its stats.
      const stats = await Promise.all(names.map((n) => fs.promises.stat(path.join(DECK_SOUNDS_DIR, n)).catch(() => null)));
      const sounds = [];
      for (let i = 0; i < names.length; i++) {
        if (stats[i]) sounds.push({ name: names[i], path: path.join(DECK_SOUNDS_DIR, names[i]), size: stats[i].size, mtime: stats[i].mtimeMs });
      }
      sounds.sort((a, b) => b.mtime - a.mtime);
      json({ ok: true, sounds });
    } catch (e) { err500(e.message); }
  },

  'GET /apps/store': async (_req, _res, { json }) => {
    // Installed Store/UWP apps for the Deck "open Store app" picker. Get-StartApps
    // lists every Start-menu entry; we keep only UWP ones (an AppID carrying the
    // PackageFamilyName!AppId separator) so a key can launch e.g. the Store Spotify,
    // which lives in a protected WindowsApps folder and can't be opened by path.
    try {
      const out = await new Promise((resolve) => {
        execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            "Get-StartApps | Where-Object { $_.AppID -like '*!*' } | Select-Object Name,AppID | ConvertTo-Json -Compress"],
          { timeout: 9000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
          (e, stdout) => resolve(e ? '' : String(stdout || '')));
      });
      const apps = [];
      if (out.trim()) {
        const parsed = JSON.parse(out);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const seen = new Set();
        for (const a of arr) {
          const value = (a && a.AppID) ? String(a.AppID) : '';
          if (!value || !value.includes('!') || seen.has(value.toLowerCase())) continue;
          seen.add(value.toLowerCase());
          apps.push({ value, label: (a && a.Name) ? String(a.Name) : value });
        }
        apps.sort((x, y) => x.label.localeCompare(y.label));
      }
      json({ ok: true, apps });
    } catch (e) { json({ ok: false, apps: [], error: e.message }); }
  },

  'GET /deck/app-icon': async (_req, _res, { json, urlObj }) => {
    // The app's OWN icon for a Deck launch key, so "open app" / "open Store app"
    // keys need no external image. `path` → an exe/lnk's embedded icon (via
    // resolveAppIcons); `aumid` → a Store/UWP app's tile logo (via
    // resolveStoreAppIcon). It mutates nothing, but it runs PowerShell on a
    // path from the query string, so it is in CSRF_MUTATION_PATHS: a page on
    // another site must not be able to aim it with an <img>. The path is
    // quoted by psQuote() (every PowerShell quote character), a network path
    // is refused, and the AUMID is charset-checked before use.
    try {
      const aumid = (urlObj.searchParams.get('aumid') || '').trim();
      const appPath = (urlObj.searchParams.get('path') || '').trim();
      let icon = null;
      if (aumid) {
        if (/^[\w.-]+![\w.-]+$/.test(aumid)) icon = await resolveStoreAppIcon(aumid);
      } else if (appPath && !isNetworkPath(appPath)) {
        // A network path is never read: asking Windows whether
        // \\host\share\x.exe exists already sends the user's NTLM hash to
        // that host. The path itself reaches PowerShell through psQuote().
        const icons = await resolveAppIcons([appPath]);
        icon = icons[0] || null;
      }
      json({ ok: !!icon, icon });
    } catch (e) { json({ ok: false, icon: null, error: e.message }); }
  },

  'GET /deck-config': async (_req, _res, { json, err500 }) => {
    try {
      const store = await readDeckStore();
      json({ configs: store.configs, rev: store.rev, savedAt: store.savedAt, instanceRevs: store.instanceRevs, presets: store.presets, keyPresets: store.keyPresets });
    } catch (e) { err500(e.message); }
  },

  'GET /pages/hotkey-status': async (_req, _res, { json, err500 }) => {
    // Settings → the page-shortcuts list: one state per row, so a combo another
    // app already owns says so on the row that has it rather than as one verdict
    // over the whole feature.
    try {
      json({
        slots: _hotkey.slots || {},
        bindings: (_hotkey.bindings || [])
          .filter((b) => b.slot !== 'spotlight' && !b.keyId)
          .map((b) => ({ slot: b.slot, combo: b.combo, target: b.target })),
        // The Deck keys' shortcuts, one verdict per key (the key editor).
        // `taken` = every combo already in use here, so the editor can refuse
        // one before it is saved.
        state: _hotkey.state,
        deck: _deckShortcutStatus(),
        taken: (_hotkey.bindings || []).map((b) => ({ combo: b.combo, keyId: b.keyId || '', slot: b.slot })),
        // The keys this PC types with AltGr, for the recorders' own check (null: all).
        altGrKeys: _altGrKeys(),
      });
    } catch (e) { err500(e.message); }
  },

  'POST /state/set': async (req, _res, { json }) => {
    // Local scripts only. On the CSRF-sensitive list below, which refuses any
    // cross-site fetch and any top-level navigation — so a page cannot reach it
    // and neither can a sandboxed widget iframe (origin null reads as
    // cross-site). A shell has no Sec-Fetch headers at all and is allowed.
    //
    //   curl -X POST 127.0.0.1:3030/state/set \
    //        -H 'Content-Type: application/json' \
    //        -d '{"name":"audio-out","value":"speakers"}'
    //
    // Omit `value` (or send null) to clear it.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      const err = setScriptState(body.name, body.value);
      if (err) { json({ ok: false, error: err }); return; }
      json({ ok: true, states: _scriptStates.states });
    } catch (e) { json({ ok: false, error: (e && e.message) || 'bad_request' }); }
  },

  'GET /state/get': async (_req, _res, { json }) => {
    // So a script can read back what it set (and a person can check their curl
    // landed) without opening the dashboard.
    json({ ok: true, states: _scriptStates.states });
  },
};

module.exports = { branches };
