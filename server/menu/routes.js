// What the engine answers about the Xenon menu: its sections, and whether it is open over the
// screen.

const { readBody } = require('../http/read-body.js');
const { _altGrKeys } = require('../deck/altgr-keys.js');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /screen-menu': async (_req, _res, { json }, { screenMenu }) => {
    // Whether the menu is open over the screen and on which section, for a page
    // that (re)connects; changes arrive over SSE `screen_menu`. Read-only.
    json(screenMenu.get());
  },

  'POST /screen-menu': async (req, res, { json }, { layersPeek, screenMenu }) => {
    // The menu page closes itself (Esc, a click outside, a row that closes it,
    // whose action `run` goes through the registry like POST /actions/run; with
    // `aside` the menu stays open and comes back when the action ended). In
    // CSRF_MUTATION_PATHS, denied to paired devices.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      if (body && body.run) { json({ ok: true, where: body.aside === true ? screenMenu.stepAside(body.run) : screenMenu.closeThenRun(body.run) }); return; }
      if (body && body.takeAsk === true) { json({ ok: true, ask: screenMenu.takeAsk() }); return; }
      // The page keeps asking while it is minimized: only the shell knows it is out of sight.
      if (body && 'peek' in body) { json({ ok: true, peek: layersPeek.set(screenMenu.isBehind() ? null : body.peek) }); return; }
      if (body && typeof body.behind === 'boolean') {
        screenMenu.setBehind(body.behind);
        if (screenMenu.isBehind()) layersPeek.set(null);
        json({ ok: true });
        return;
      }
      if (body && body.sheet) { json({ ok: true, where: screenMenu.showSheet(body.sheet, body.ask) }); return; }
      json({ ok: true, where: body && body.open === true ? screenMenu.show({ section: body.section }) : screenMenu.close() });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
    }
  },

  'GET /xenon-menu': async (_req, _res, { json, err500 }, { _xenonMenuState }) => {
    // The menu's sections (xenon-menu.js), the same for the screen and the
    // dashboard panel (a paired phone's too). Read-only, never a path.
    try { json({ ...(await _xenonMenuState()), altGrKeys: _altGrKeys() }); } catch (e) { err500(e.message); }
  },

  'GET /menu': async (_req, _res, { sendPage }) => {
    // The Xenon menu over the main screen (js/screen-menu-page.js), shown by the
    // shell while it is open (screen-menu.js). Denied to a paired device in
    // remote-access.js.
    await sendPage(await fs.promises.readFile(path.join(SERVER_DIR, 'menu.html'), 'utf8'));
  },
};

module.exports = { branches };
