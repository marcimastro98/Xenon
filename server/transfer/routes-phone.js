// What the engine answers about the phone: its state, contacts, calls and messages, sending a
// message, dialling, what a button of the call card does, and a made-up call that rings only
// when testing is turned on.

const { readBody } = require('../http/read-body.js');
const callDetect = require('../call-detect.js');
const calls = require('../calls.js');
const { callsSettings } = require('./calls-settings.js');
const winNotif = require('../winnotif.js');
const { discordMirror } = require('../discord/mirrored.js');

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
};

module.exports = { branches };
