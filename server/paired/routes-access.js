// What the engine does about the devices paired with it: turning the access on, cancelling a
// pairing, redeeming a code, renaming a device, and revoking one or all of them.

const { readBody } = require('../http/read-body.js');
const { withHubSettingsLock } = require('../settings/write-lock.js');
const { nextSettingsRev } = require('../settings-rev.js');
const { hub } = require('../settings/current.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const remoteAccessLib = require('../remote-access.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /api/remote-access/enable': async (req, res, { json, err500 }, { _dropRemoteSockets, _syncRemoteHttps, applyBindHost, readHubSettingsForUpdate, remoteAccess, writeHubSettings }) => {
    // The opt-in. Turning it OFF also hangs up on every connected device: a
    // switch that leaves live streams running is a switch that lies.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const value = body.value === true;
      await withHubSettingsLock(async () => {
        const cur = await readHubSettingsForUpdate();
        // Spread the stored block rather than replacing it: this endpoint owns
        // ONE field of it. Writing `{ enabled: value }` wholesale is how the
        // sibling flag gets silently reset by an unrelated toggle — the same
        // shape as the bug that switched paired access off on every save.
        const saved = await writeHubSettings({
          ...cur,
          remoteAccess: { ...(cur.remoteAccess || {}), enabled: value },
          rev: nextSettingsRev(cur.rev, body.rev),
        });
        hub.settings = saved;
        broadcastSSE('settings', { rev: saved.rev });
      });
      if (!value) { remoteAccess.cancelPairing(); _dropRemoteSockets(null); }
      // Open the listener to the LAN, or close it back to loopback. Without
      // this the switch changed a flag and nothing else: the QR advertised
      // http://<lan-ip>:PORT/pair while the socket stayed on 127.0.0.1, and the
      // phone got a connection error with no explanation anywhere.
      // The HTTPS door serves the paired-device door and nothing else, so it
      // follows it down — and back up, if it was on before.
      _syncRemoteHttps();
      json({ ok: true, enabled: value });
      // After the answer is out: moving the listener closes every open
      // connection, this request's included, so doing it first left the
      // caller with an empty reply.
      res.once('finish', () => { setImmediate(() => { try { applyBindHost(); } catch { /* stays where it is */ } }); });
    } catch (e) { err500(e.message); }
  },

  'POST /api/remote-access/pair/cancel': async (req, _res, { json, err500 }, { remoteAccess }) => {
    try { await readBody(req); remoteAccess.cancelPairing(); json({ ok: true }); }
    catch (e) { err500(e.message); }
  },

  'POST /api/remote-access/redeem': async (req, res, { err500 }, { _peerIp, remoteAccess }) => {
    // The one pre-auth write on the paired-device door. Reached ONLY through
    // _remoteGate, which has already checked Host/Origin/Sec-Fetch-Site and
    // rate-limited the source address; redeem() rate-limits again per address
    // and burns the code after a handful of wrong guesses.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = await remoteAccess.redeem(body.code, { name: body.name, ip: _peerIp(req) });
      if (!r.ok) {
        // A refusal never says which part was wrong.
        res.writeHead(r.error === 'rate_limited' ? 429 : 403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: r.error }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        // `Secure` follows the door the pairing happened on: over plain HTTP the
        // browser would discard a Secure cookie entirely and pairing would look
        // like it silently did nothing.
        'Set-Cookie': remoteAccessLib.cookieHeader(r.token, { secure: !!(req.socket && req.socket.encrypted) }),
      });
      res.end(JSON.stringify({ ok: true, device: { id: r.device.id, name: r.device.name } }));
      // Tell the PC's screens (main.js shows a toast): pairing needs only the
      // code, so the person at the PC should see every device that gets in.
      broadcastSSE('remote_paired', { name: r.device.name });
    } catch (e) { err500(e.message); }
  },

  'POST /api/remote-access/rename': async (req, _res, { json, err500 }, { remoteAccess }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await remoteAccess.rename(String(body.id || ''), body.name));
    } catch (e) { err500(e.message); }
  },

  'POST /api/remote-access/revoke': async (req, _res, { json, err500 }, { _dropRemoteSockets, remoteAccess, webPush }) => {
    // Revocation must be instant, so drop the device's live sockets too — its
    // SSE stream would otherwise keep feeding it system data until the phone
    // gave up on its own.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const id = String(body.id || '');
      const r = await remoteAccess.revoke(id);
      if (r.ok) {
        _dropRemoteSockets(id);
        // A revoked device cannot unsubscribe itself — its token is already
        // dead — so a push subscription would outlive the access it was made
        // under, and the phone would keep being woken by a dashboard it can no
        // longer open. Dropping it here is the only place that can.
        await webPush.dropDevice(id).catch((e) => console.warn('[web-push] drop failed:', e.message));
      }
      json(r);
    } catch (e) { err500(e.message); }
  },

  'POST /api/remote-access/revoke-all': async (req, _res, { json, err500 }, { _dropRemoteSockets, remoteAccess, webPush }) => {
    // The kill switch. Mirrors the Remote-Control panel's one-tap revoke.
    try {
      await readBody(req);
      const r = await remoteAccess.revokeAll();
      _dropRemoteSockets(null);
      // Same reasoning as the single revoke, for every device at once. The
      // loopback surface's own subscription (deviceId '') is deliberately kept:
      // it was never a paired device and the kill switch is about those.
      for (const s of await webPush.list()) {
        if (s.deviceId) await webPush.dropDevice(s.deviceId).catch(() => {});
      }
      json(r);
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
