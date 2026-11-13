// What the engine answers about using the PC from another device: the status, the install, the
// Tailscale sign-in, the Sunshine setup, the PIN, the switch that cuts it off, turning it on,
// off or on demand, the screens, closing a session, and blocking or unblocking.

const remoteAccessLib = require('../remote-access.js');
const { readBody } = require('../http/read-body.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /remote/status': async (_req, _res, { json, err500, isRemote }, { remoteControl }) => {
    try {
      const state = await remoteControl.status();
      json(isRemote ? remoteAccessLib.withoutLoginLink(state) : state);
    } catch (e) { err500(e.message); }
  },

  'POST /remote/install': async (req, res, { json, err500 }, { remoteControl }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = await remoteControl.installTool(body.tool);
      if (ok) { json({ ok }); } else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok })); }
    } catch (e) { err500(e.message); }
  },

  'POST /remote/tailscale/login': async (req, _res, { json, err500 }, { remoteControl }) => {
    try {
      await readBody(req);
      await remoteControl.startTailscaleLogin();
      json({ ok: true });
    } catch (e) { err500(e.message); }
  },

  'POST /remote/sunshine/configure': async (req, res, { json }, { remoteControl }) => {
    try {
      await readBody(req);
      await remoteControl.configureSunshine();
      json({ ok: true });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  },

  'POST /remote/pin': async (req, res, { json, err500 }, { remoteControl }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = await remoteControl.sendPin(body.pin);
      if (result.ok) { json({ ok: true }); }
      else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, status: result.status })); }
    } catch (e) { err500(e.message); }
  },

  'POST /remote/kill': async (req, _res, { json, err500 }, { remoteControl }) => {
    try {
      await readBody(req);
      const ok = await remoteControl.killSwitch();
      json({ ok });
    } catch (e) { err500(e.message); }
  },

  'POST /remote/enable': async (req, _res, { json, err500 }, { remoteControl }) => {
    try {
      await readBody(req);
      await remoteControl.enable();
      json({ ok: true });
    } catch (e) {
      // Sunshine too old (or its version unreadable): said, not a bare 500.
      if (e && /^sunshine_/.test(String(e.code || ''))) { json({ ok: false, error: e.code, message: e.message }); return; }
      err500(e.message);
    }
  },

  'POST /remote/disable': async (req, _res, { json, err500 }, { remoteControl }) => {
    try {
      await readBody(req);
      await remoteControl.disable();
      json({ ok: true });
    } catch (e) { err500(e.message); }
  },

  'POST /remote/ondemand': async (req, _res, { json, err500 }, { remoteControl }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = await remoteControl.setOnDemand(body.value === true);
      json({ ok });
    } catch (e) { err500(e.message); }
  },

  'GET /remote/screens': async (_req, _res, { json, err500 }, { remoteControl }) => {
    try { json(await remoteControl.listScreens()); }
    catch (e) { err500(e.message); }
  },

  'POST /remote/screen': async (req, res, { json, err500 }, { remoteControl }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = await remoteControl.setScreen(body.id);
      if (ok) { json({ ok: true }); } else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false })); }
    } catch (e) { err500(e.message); }
  },

  'POST /remote/screen/cycle': async (req, _res, { json, err500 }, { remoteControl }) => {
    try { await readBody(req); const active = await remoteControl.cycleScreen(); json({ ok: !!active, active }); }
    catch (e) { err500(e.message); }
  },

  'POST /remote/session/close': async (req, _res, { json, err500 }, { remoteControl }) => {
    try { await readBody(req); const ok = await remoteControl.closeSession(); json({ ok }); }
    catch (e) { err500(e.message); }
  },

  'POST /remote/block': async (req, _res, { json, err500 }, { remoteControl }) => {
    try { await readBody(req); const ok = await remoteControl.blockAccess(); json({ ok }); }
    catch (e) { err500(e.message); }
  },

  'POST /remote/unblock': async (req, _res, { json, err500 }, { remoteControl }) => {
    try { await readBody(req); const ok = await remoteControl.unblockAccess(); json({ ok }); }
    catch (e) { err500(e.message); }

  // ── Paired-device access (R1.1) ────────────────────────────────────────────
  // Everything below except /redeem and /whoami is LOOPBACK-ONLY, and not
  // because a handler says so: none of these paths is on the remote allowlist
  // in remote-access.js, so a paired device is refused before reaching them.
  // That is the intended shape — a phone can never enrol another phone, revoke
  // the device that would kick it off, or turn the feature off from outside.
  },
};

module.exports = { branches };
