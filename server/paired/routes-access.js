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

  'GET /api/remote-access/status': async (_req, _res, { json }, { PORT, _remoteHttpsState, remoteAccess, remoteAccessEnabled, remoteHttpsInstaller, remoteHttpsSetup }) => {
    // Everything the Settings panel needs to render itself, in one read.
    const addresses = remoteAccessLib.pairingAddresses();
    json({
      enabled: remoteAccessEnabled(),
      port: PORT,
      addresses,
      devices: remoteAccess.list(),
      maxDevices: remoteAccessLib.MAX_DEVICES,
      pairing: remoteAccess.pairingState(),
      // The T2 door, as two separate facts: what the user ASKED for, and what
      // actually happened. Collapsing them would make a switch that silently
      // flicks itself back off — the panel needs to show it on, and next to it
      // the one reason it did not come up.
      httpsEnabled: !!(hub.settings && hub.settings.remoteAccess && hub.settings.remoteAccess.https === true),
      // Whether this machine can bring that door up at all. Everything the door
      // is made of — the Tailscale CLI, its certificate, a TLS listener — exists
      // identically on all three platforms, so this is true everywhere and the
      // flag stays only because a future platform may not manage it.
      httpsSupported: true,
      // Whether Xenon can INSTALL Tailscale itself, which is a different
      // question — and no longer a Windows-only yes. winget, Homebrew and
      // pkexec+dnf/apt are the same offer wearing three faces, so this is asked
      // of the machine rather than assumed from the platform: a Linux box with
      // no polkit agent and a Mac with no Homebrew both answer false, and there
      // the panel prints the exact command instead of offering a dead button.
      httpsAutoInstall: await remoteHttpsInstaller.canInstall('tailscale').catch(() => false),
      // Probed live while the door is down (see refreshReason): the cached
      // reason belongs to whenever the last attempt ran, which at boot is
      // before Tailscale's own client has attached — and printing THAT at
      // somebody staring at a connected Tailscale is how this reads as Xenon
      // being unable to see it.
      https: await _remoteHttpsState(),
      // The guided setup, when one is running: which step, and whether it is
      // parked on the one thing the user has to do elsewhere.
      httpsSetup: remoteHttpsSetup.status(),
    });
  },

  'POST /api/remote-access/https': async (req, _res, { json, err500 }, { _syncRemoteHttps, readHubSettingsForUpdate, remoteHttps, writeHubSettings }) => {
    // The T2 opt-in. Answers with the REASON when it cannot come up, because
    // every failure here is fixable and each one somewhere different: install
    // Tailscale, start it, log in, or — the one that is not on this machine at
    // all — switch HTTPS Certificates on for the tailnet in the admin console.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const value = body.value === true;
      await withHubSettingsLock(async () => {
        const cur = await readHubSettingsForUpdate();
        const saved = await writeHubSettings({
          ...cur,
          remoteAccess: { ...(cur.remoteAccess || {}), https: value },
          rev: nextSettingsRev(cur.rev, body.rev),
        });
        hub.settings = saved;
        broadcastSSE('settings', { rev: saved.rev });
      });
      await _syncRemoteHttps();
      json({ ok: true, https: value, state: remoteHttps.status() });
    } catch (e) { err500(e.message); }
  },

  'POST /api/remote-access/https/setup': async (req, _res, { json, err500 }, { remoteHttpsSetup }) => {
    // The one button. Installs Tailscale if it is missing, opens the sign-in if
    // it is not signed in, then waits — politely and for a long time — for the
    // certificate switch that lives in Tailscale's own admin console and cannot
    // be flipped from here. Returns immediately; the panel polls /status.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.cancel === true) { json(remoteHttpsSetup.cancel()); return; }
      json(remoteHttpsSetup.start());
    } catch (e) { err500(e.message); }
  },

  'POST /api/remote-access/pair': async (req, _res, { json, err500 }, { PORT, remoteAccess, remoteAccessEnabled, remoteHttps }) => {
    // Open a pairing window. The code is returned to the LOCAL dashboard only,
    // which renders it as a QR; it never travels anywhere else.
    try {
      await readBody(req);
      if (!remoteAccessEnabled()) { json({ ok: false, error: 'disabled' }); return; }
      const addresses = remoteAccessLib.pairingAddresses();
      if (!addresses.length) { json({ ok: false, error: 'no_network' }); return; }
      const p = remoteAccess.startPairing();
      // When the HTTPS door is up, its URL is the one to hand out — and the only
      // one. It reaches the PC both at home and away, it is a secure context (so
      // the phone can install it as an app and use its microphone), and its name
      // does not change when the router hands out a different lease. Cookies are
      // scoped per host, so a phone paired on the LAN IP is NOT paired on the
      // MagicDNS name: offering both would mean pairing the same phone twice.
      const tls = remoteHttps.status();
      json({
        ok: true, code: p.code, display: p.display, expiresAt: p.expiresAt,
        addresses, port: PORT,
        secureUrl: tls.running ? tls.url : '',
      });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
