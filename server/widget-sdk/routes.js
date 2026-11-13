// What the engine takes from a widget: the answer to a Deck call and the states of its keys.

const { readBody } = require('../http/read-body.js');
const { sdkHandlerAck } = require('./handler-calls.js');
const { sdkFeatureEnabled } = require('./grants.js');
const { acceptSdkDeckStates } = require('./deck-states.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
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
};

module.exports = { branches };
