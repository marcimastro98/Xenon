// What the engine answers about the phone: its state, contacts, calls and messages, sending a
// message, dialling, what a button of the call card does, and a made-up call that rings only
// when testing is turned on.

const { readBody } = require('../http/read-body.js');
const callDetect = require('../call-detect.js');
const calls = require('../calls.js');
const { callsSettings } = require('./calls-settings.js');
const winNotif = require('../winnotif.js');
const { discordMirror } = require('../discord/mirrored.js');
const fs = require('node:fs');
const { DATA_DIR } = require('../engine/paths.js');
const { TRANSFER_DISK_HEADROOM } = require('./limits.js');
const fileTransferLib = require('../file-transfer.js');
const { broadcastSSE } = require('../http/sse-clients.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /api/calls/test': async (req, res, { json, err500 }) => {
    // Ring a fake call, so the feature can be exercised without arranging for
    // somebody to phone you. OFF unless XENON_CALLS_TEST=1 is in the
    // environment — same shape as the Discord RPC debug flag, and for the same
    // reason: a normal install must not carry an endpoint that can take over
    // the screen. Absent the flag it 404s like any unknown route, so nothing
    // about a production install even hints it exists.
    //
    // It synthesises a NOTIFICATION and feeds it to the real classifier rather
    // than injecting a finished card. That is the point: it tests the path the
    // product actually uses — matching, the ring-phrase check, the capability
    // computation, the broadcast and the push — instead of proving that a
    // hand-made object can be displayed.
    if (process.env.XENON_CALLS_TEST !== '1') { res.writeHead(404); res.end(); return; }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const appId = String(body.app || 'teams');
      const caller = String(body.caller || 'Marco Rossi').slice(0, 80);
      const video = body.video === true;
      const entry = callDetect.DEFAULT_APPS.find(a => a.id === appId);
      if (!entry) { json({ ok: false, error: 'unknown_app', known: callDetect.DEFAULT_APPS.map(a => a.id) }); return; }
      const wording = video ? 'Incoming video call' : 'Incoming call';
      const rec = appId === 'discord'
        ? calls.onDiscordNotification({ title: caller, body: wording, channelId: '199737254929760257', messageType: 3 })
        : calls.onNotification({ app: entry.name, aumid: entry.match[0], title: caller, body: wording, at: Date.now() });
      // A null means the classifier refused it — feature off, app switched off,
      // or the same ring already counted. Say which rather than a bare false.
      json(rec
        ? { ok: true, ringing: calls.current() }
        : { ok: false, error: calls.enabled() ? 'refused_or_duplicate' : 'calls_disabled' });
    } catch (e) { err500(e.message); }
  },

  'POST /api/calls/act': async (req, _res, { json, err500 }) => {
    // The one place a call button does anything. Every action is re-checked
    // against the capabilities the server itself computed — the card is not
    // trusted to have drawn only the buttons it was allowed to.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const id = String(body.id || '').slice(0, 64);
      const action = String(body.action || '').slice(0, 16);
      json(await calls.act(id, action));
    } catch (e) { err500(e.message); }
  },

  'GET /api/phone': async (_req, _res, { json, err500, urlObj }, { phone }) => {
    // What this machine and this phone can actually do, plus the live call
    // state. The widget renders its buttons from `canDial` / `canAnswer`, so a
    // capability that is false here is a control the user never sees rather
    // than one that fails when tapped.
    try { json(await phone.status(urlObj.searchParams.get('refresh') === '1')); }
    catch (e) { err500(e.message); }
  },

  'GET /api/phone/contacts': async (_req, _res, { json, err500, urlObj }, { phone }) => {
    // The user's own address book, read off their own phone. Never JSONP —
    // a <script> tag would hand every contact to any page that asked.
    try { json(await phone.contacts(urlObj.searchParams.get('refresh') === '1')); }
    catch (e) { err500(e.message); }
  },

  'GET /api/phone/calls': async (_req, _res, { json, err500, urlObj }, { phone }) => {
    try { json(await phone.calls(urlObj.searchParams.get('refresh') === '1')); }
    catch (e) { err500(e.message); }
  },

  'GET /api/phone/messages': async (_req, _res, { json, err500, urlObj }, { phone }) => {
    // The message list. Reachable from a paired device for the same reason the
    // Windows notification mirror is: it is the user's own dashboard, and that
    // mirror already shows the text of the very same messages.
    try {
      json(await phone.messages(
        urlObj.searchParams.get('folder') || 'inbox',
        urlObj.searchParams.get('refresh') === '1',
      ));
    } catch (e) { err500(e.message); }
  },

  'GET /api/phone/message': async (_req, _res, { json, err500, urlObj }, { phone }) => {
    try {
      json(await phone.message(
        urlObj.searchParams.get('folder') || 'inbox',
        urlObj.searchParams.get('handle') || '',
      ));
    } catch (e) { err500(e.message); }
  },

  'POST /api/phone/send': async (req, _res, { json, err500 }, { phone }) => {
    // Sends a real SMS, from the user's number, to somebody else. Same class as
    // /dial: outward-facing, metered, and impossible to take back — so POST
    // only, CSRF-guarded, and refused from a paired device.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await phone.sendMessage(String(body.number || '').slice(0, 40), String(body.text || '').slice(0, 2000)));
    } catch (e) { err500(e.message); }
  },

  'POST /api/phone/dial': async (req, _res, { json, err500 }, { phone }) => {
    // The only outbound action in the feature: it places a real call, on a real
    // network, that costs the user money. POST-only, CSRF-guarded, and refused
    // outright from a paired device (see REMOTE_DENY — the audio comes out of
    // the PC, so dialling from a tablet starts a call nobody can hear).
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await phone.dial(String(body.number || '').slice(0, 40)));
    } catch (e) { err500(e.message); }
  },

  'GET /api/calls': async (_req, _res, { json }, { keySendAvailable, keySendProblem }) => {
    // Seed + capability report for the call card. `keys`/`keysProblem` are what
    // the Settings panel uses to explain why an Answer button is missing on this
    // machine (no Accessibility grant on macOS, no xdotool/ydotool on Linux)
    // instead of leaving the user to guess. A ringing call carries the caller's
    // name, so this is loopback-or-paired-device like the rest and NEVER JSONP.
    const c = callsSettings();
    json({
      ok: true,
      enabled: c.enabled,
      sound: c.sound,
      push: c.push,
      calls: calls.current(),
      capabilities: {
        keys: keySendAvailable(),
        keysProblem: keySendProblem(),
        notifications: winNotif.isSupported(),
        discord: discordMirror.linkedForCalls,
      },
    });
  },

  'POST /api/transfer/upload': async (req, res, { json, urlObj, isRemote, remote }, { broadcastTransfer, deliverTransfer, fileTransfer, transferEnabled, transferPushBody, transferSettings, webPushNotify }) => {
    // The ONLY route in this server that streams a request body to disk.
    // readBody/readBodyBuffer would make a 2 GB video 2 GB of RSS, and every
    // other upload here does exactly that — this is the one that cannot.
    //
    // `req` is untouched at this point: nothing in handleRequest reads a body
    // before the dispatch chain, so the stream still holds every byte. If that
    // ever changes, this route breaks silently — file-transfer-routes.test.mjs
    // pins it.
    //
    // Not multipart: parseMultipartBackground works on an already-buffered
    // Buffer, and a streaming multipart parser is a state machine over chunk
    // boundaries that this repo should not grow. The filename rides in the
    // query as a LABEL, the /api/claude/attach shape.
    if (!transferEnabled()) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'disabled' }));
      return;
    }
    const declaredLength = Number(req.headers['content-length']) || 0;
    // Cap one: answered before a byte is read. This is the common case and it
    // costs nothing. Cap two lives inside receiveStream and counts the bytes as
    // they arrive, because a Content-Length is a claim and chunked encoding
    // carries none at all. Cap three is the quota, inside begin().
    const began = fileTransfer.begin({
      name: urlObj.searchParams.get('name') || '',
      // Derived from which door this arrived at, never from the request: a
      // phone must not be able to claim it is the PC, and has no reason to.
      direction: isRemote ? 'in' : 'out',
      from: isRemote ? ((remote.device && remote.device.name) || 'device') : 'PC',
      declaredLength,
    });
    if (began.error) {
      res.writeHead(began.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: began.error, max: began.max }));
      return;
    }
    // Cap four: never let a transfer be the thing that fills the system drive.
    // statfs is best-effort — an older runtime or an exotic filesystem answers
    // with a throw, and "unknown" must mean "carry on", not "refuse".
    try {
      const vfs = await fs.promises.statfs(DATA_DIR);
      const free = Number(vfs.bavail) * Number(vfs.bsize);
      if (Number.isFinite(free) && declaredLength && (free - declaredLength) < TRANSFER_DISK_HEADROOM) {
        fileTransfer.abort(began.id);
        res.writeHead(507, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no_space' }));
        return;
      }
    } catch { /* the filesystem cannot say; proceed and let ENOSPC speak */ }

    let received = 0;
    try {
      // The row appears on every other surface the moment the upload starts,
      // so a phone sending from the sofa shows up on the PC as it happens.
      broadcastTransfer();

      // The streaming core lives in file-transfer.js (receiveStream): bounded
      // during the stream rather than from Content-Length, request kept alive
      // so an over-size body can still be answered, temp removed on any
      // failure. It is there rather than here so it can be exercised against a
      // real socket in the tests.
      const out = await fileTransferLib.receiveStream(req, began.target, {
        limit: began.limit,
        onProgress: (n) => {
          received = n;
          if (fileTransfer.noteProgress(began.id, n)) {
            broadcastSSE('transfer_progress', { id: began.id, received: n, total: declaredLength, done: false });
          }
        },
      });
      received = out.bytes;
      const rec = await fileTransfer.commit(began.id, received);
      broadcastSSE('transfer_progress', { id: began.id, received, total: received, done: true });
      // Delivery is a copy made AFTER the file is safely stored, so a folder
      // that was renamed or filled up degrades to "kept in Xenon's inbox" and
      // never fails a transfer that already succeeded.
      const delivered = await deliverTransfer(rec).catch(() => null);
      fileTransfer.prune().catch(() => {});
      broadcastTransfer();
      // Push is PC → phone only, opt-in, and never carries the file name: a
      // lock screen is a public surface. A file the user just sent FROM the
      // phone in their hand is not something to wake them for.
      if (rec.direction === 'out' && transferSettings().notifyPhone) {
        webPushNotify({
          title: 'Xenon',
          body: transferPushBody(),
          tag: 'transfer',
          url: '/',
        }, { urgency: 'normal', ttl: 3600 }).catch(() => {});
      }
      json({ ok: true, id: rec.id, name: rec.name, size: rec.size, delivered: !!delivered });
    } catch (e) {
      // receiveStream has already removed the temp file and left `req` alive.
      fileTransfer.abort(began.id);
      if (Number.isFinite(e && e.received)) received = e.received;
      broadcastSSE('transfer_progress', { id: began.id, received, total: declaredLength, done: true, failed: true });
      broadcastTransfer();
      if (res.headersSent) { try { res.end(); } catch { /* already gone */ } return; }
      const code = e && e.code;
      if (code === 'XFER_ABORTED' || code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
        // The phone slept or the wifi went. There is nobody left to answer.
        try { res.end(); } catch { /* socket already closed */ }
        return;
      }
      const status = code === 'XFER_TOO_BIG' ? 413 : (code === 'ENOSPC' ? 507 : 500);
      const error = code === 'XFER_TOO_BIG' ? 'too_big' : (code === 'ENOSPC' ? 'no_space' : 'write_failed');
      res.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ ok: false, error, max: began.limit }));
      // Only once the refusal has actually flushed. Destroying the socket any
      // earlier is what turns a clear 413 into "network error".
      res.on('finish', () => { try { req.destroy(); } catch { /* already gone */ } });
    }
  },
};

module.exports = { branches };
