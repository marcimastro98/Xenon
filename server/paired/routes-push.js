// What the engine answers about notifications sent to a paired device: the key, an unsubscribe,
// the status and a test.

const { readBody } = require('../http/read-body.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /api/push/key': async (req, _res, { json, err500 }, { webPush }) => {
    // POST rather than GET because the FIRST call mints the VAPID key pair and
    // writes it to disk. A GET that creates a keypair is exactly the shape the
    // CSRF invariant exists to catch, and calling it a POST costs the client one
    // character and removes the argument entirely.
    try {
      await readBody(req);
      json({ ok: true, key: await webPush.publicKey() });
    } catch (e) { err500(e.message); }
  },

  'POST /api/push/unsubscribe': async (req, _res, { json, err500 }, { webPush }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await webPush.unsubscribe(String(body.endpoint || '')));
    } catch (e) { err500(e.message); }
  },

  'GET /api/push/status': async (req, _res, { json, err500 }, { webPush }) => {
    // Read-only, and deliberately says nothing an attacker could use: whether a
    // key exists, how many devices are subscribed, and whether THIS one is —
    // never an endpoint, which is the bearer address of someone's phone.
    try {
      const body = req.headers['x-xenon-endpoint'];
      json({
        ok: true,
        hasKeys: webPush.hasKeys(),
        count: webPush.count(),
        subscribed: body ? await webPush.hasSubscription(String(body)) : null,
        devices: await webPush.list(),
      });
    } catch (e) { err500(e.message); }
  },

  'POST /api/push/test': async (req, _res, { json, err500 }, { webPushNotify }) => {
    // The "did that actually work" button. It is the only way a user can tell:
    // everything else about push is invisible until something happens at three
    // in the morning.
    //
    // The text comes from the CLIENT because the client is the only side of
    // this that has all eleven languages; the server holds no UI strings. It is
    // clamped by webPush.send() like any other message, and this endpoint sends
    // nothing but what the person pressing the button just wrote on their own
    // dashboard — reaching it at all already requires being a paired device.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = await webPushNotify({
        title: String(body.title || 'Xenon'),
        body: String(body.body || 'Notifications are working.'),
        tag: 'xenon-test',
      }, { urgency: 'high', ttl: 60 });
      json(r);
    } catch (e) { err500(e.message); }
  },

  'POST /api/push/subscribe': async (req, _res, { json, err500, remote }, { webPush }) => {
    // The browser has just been given an address by its push service and is
    // handing it over. It is tied to the DEVICE that presented it, so a revoke
    // can take it away again; on the PC itself there is no device, and the
    // empty id is a real value meaning "this machine".
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const deviceId = (remote && remote.device && remote.device.id) || '';
      json(await webPush.subscribe(body.subscription || body, { deviceId }));
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
