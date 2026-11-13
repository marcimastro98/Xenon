// What the engine answers to the windows that show widgets on the desktop: whether they are
// being edited, what the app window can draw, and their strings in the saved language.

const LayerI18n = require('../layer-strings.js');
const { hub } = require('../settings/current.js');
const { readBody } = require('../http/read-body.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /layer-i18n.js': async (req, res) => {
    // Every page's strings: the saved language and the browser's, plus English.
    // no-store, so a window reloaded after a language change gets it.
    try {
      const langs = LayerI18n.wantedLanguages(hub.settings.language, req.headers['accept-language']);
      const js = await LayerI18n.scriptFor(langs, hub.settings.language);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(js);
    } catch (e) {
      console.error('[layer-i18n]', e && e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('layer strings unavailable');
    }
  },

  'GET /layers/edit': async (_req, _res, { json }, { layersEdit, layersPeek }) => {
    // A layer window opened (or reconnected) during edit mode reads it here;
    // later changes arrive over SSE `layers-edit`. Read-only.
    json({ on: layersEdit.get(), peek: layersPeek.get() });
  },

  'POST /layers/host': async (req, res, { json }, { _menuHotkey, layersHost, refreshHotkeyListener }) => {
    // The native shell reports what it can draw (layers-host.js); the `layers`
    // capability probe reads it. Re-sent while the shell runs; the report expires.
    // In CSRF_MUTATION_PATHS, denied to paired devices in remote-access.js.
    try {
      const body = JSON.parse(await readBody(req, 16 * 1024) || '{}');
      const menuKey = _menuHotkey();
      const accepted = layersHost.accept(body);
      // A shell that can draw the menu arms its shortcut (and frees it on quit).
      if (_menuHotkey() !== menuKey) { try { refreshHotkeyListener(); } catch { /* the next report retries */ } }
      json(accepted);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
    }
  },

  'POST /layers/desk': async (req, res, { json }, { _deskPageSync, layersHost }) => {
    // The shell says which virtual desktop is shown (apps/native layers/desks.rs,
    // through js/layers-shell.js); a page tied to it is shown (layer-pages.js).
    // In CSRF_MUTATION_PATHS, denied to paired devices in remote-access.js.
    try {
      const body = JSON.parse(await readBody(req, 1024) || '{}');
      const current = Number(body && body.current);
      const count = Number(body && body.count);
      if (!Number.isInteger(current) || current < 0 || current > 64 || !Number.isInteger(count) || count < 0 || count > 64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
        return;
      }
      layersHost.setDesk(current, count);
      _deskPageSync(current);
      json({ ok: true });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
    }
  },
};

module.exports = { branches };
