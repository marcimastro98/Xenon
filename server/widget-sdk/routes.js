// What the engine takes from a widget: the answer to a Deck call and the states of its keys.

const { readBody } = require('../http/read-body.js');
const { sdkHandlerAck } = require('./handler-calls.js');
const { sdkFeatureEnabled } = require('./grants.js');
const { acceptSdkDeckStates } = require('./deck-states.js');
const fs = require('node:fs');
const path = require('node:path');
const { EXAMPLE_WIDGETS } = require('./example-widgets.js');
const { SDK_WIDGETS_DIR } = require('./data-places.js');

const SERVER_DIR = path.join(__dirname, '..');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /sdk/handler-ack': async (req, _res, { json }) => {
    // The dashboard page acks a dispatched sdk_handler call on behalf of the
    // widget frame that handled it (the sandboxed frame itself has no network —
    // the CSP kill-switch stays intact; this POST comes from the host page).
    // First ack wins; late/unknown callIds are a harmless no-op.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      json({ ok: true, matched: sdkHandlerAck(body.callId, body.ok !== false, body.error) });
    } catch (e) { json({ ok: false, error: (e && e.message) || 'bad_request' }); }
  },

  'POST /sdk/deck-states': async (req, _res, { json }) => {
    // The HOST page mirrors widget-published deck states here so the Virtual
    // Deck popup (no widget frames) can light sdkState keys. POST-only JSON
    // from the dashboard page (Origin layer); values re-validated + bounded in
    // acceptSdkDeckStates; rebroadcast only when something actually changed.
    try {
      if (!sdkFeatureEnabled()) { json({ ok: false, error: 'sdk_disabled' }); return; }
      // 256KB: worst case is 256 states × (120-char key + 200-char value +
      // meta + JSON escaping) — a 32KB cap would silently reject a busy relay
      // and leave the popup's sdkState keys permanently dark.
      const body = JSON.parse(await readBody(req, 262144) || '{}');
      json({ ok: true, changed: acceptSdkDeckStates(body) });
    } catch (e) { json({ ok: false, error: (e && e.message) || 'bad_request' }); }
  },

  'GET /shell-driver': async (_req, _res, { sendPage }) => {
    // The hidden page of "widgets only" (js/shell-driver.js). Denied to a paired
    // device in remote-access.js; loopback only, like '/'.
    await sendPage(await fs.promises.readFile(path.join(SERVER_DIR, 'shell-driver.html'), 'utf8'));
  },

  'GET /sdk-service': async (_req, _res, { sendPage }) => {
    // "Widgets only": the hidden page that runs the Store widgets' background
    // frames (js/sdk-service.js), held by the driver page. Denied to a paired
    // device in remote-access.js; loopback only, like '/'.
    await sendPage(await fs.promises.readFile(path.join(SERVER_DIR, 'sdk-service.html'), 'utf8'));
  },

  'POST /sdk/widgets/example': async (req, _res, { json }, { recordWidgetOrigin, refreshSdkScan }) => {
    // One-click install of a bundled reference widget: copies the example
    // package from the app tree into DATA_DIR/widgets. The requested id is
    // resolved through a fixed allowlist map — never interpolated into a
    // path — so request input still never reaches the filesystem directly;
    // an unknown/missing id falls back to the original default.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      const folder = (typeof body.id === 'string' && Object.hasOwn(EXAMPLE_WIDGETS, body.id))
        ? EXAMPLE_WIDGETS[body.id] : EXAMPLE_WIDGETS['hello-xenon'];
      const src = path.join(SERVER_DIR, 'sdk-example', folder);
      const dest = path.join(SDK_WIDGETS_DIR, folder);
      await fs.promises.mkdir(dest, { recursive: true });
      for (const name of await fs.promises.readdir(src)) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
        await fs.promises.copyFile(path.join(src, name), path.join(dest, name));
      }
      await recordWidgetOrigin(folder, 'builtin');   // shipped example, not the user's work
      await refreshSdkScan();   // the new package is visible to hot paths immediately
      json({ ok: true });
    } catch {
      json({ ok: false, error: 'install_failed' });
    }
  },
};

module.exports = { branches };
