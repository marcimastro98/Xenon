// What the engine answers about icon packs and sound packs, and where the automatic update of
// widgets stands.

const { readBodyBuffer } = require('../http/read-body.js');
const { ICON_PACK_BODY_MAX, SOUND_PACK_BODY_MAX } = require('../deck/pack-places.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/widgets/auto-update': async (_req, _res, { json, err500 }, { widgetAutoUpdater }) => {
    // Where the widget auto-updater stands, for the line in Settings -> Widget e
    // condivisione: the switch, the last run, and what is waiting for the user.
    // Read-only, names and versions only.
    try { json(await widgetAutoUpdater.status()); } catch (e) { err500(e.message); }
  },

  'POST /icon-pack': async (req, res, { json }, { iconPackStore }) => {
    // Install a Deck icon pack (the 'icons' preset kind). Reached only from the
    // import preview's Apply step. All validation is fail-closed in
    // icon-packs.js (SVG reject-list, PNG magic bytes, id charsets, size caps);
    // files land under server-derived names via a temp-dir + rename install.
    try {
      const body = await readBodyBuffer(req, ICON_PACK_BODY_MAX);
      let payload = null;
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; }
      const result = await iconPackStore.install(payload);
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      json(result);
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
  },

  'GET /icon-packs': async (_req, _res, { json, err500 }, { iconPackStore }) => {
    // Installed icon-pack manifests (no file data) — feeds the Deck key icon
    // picker's pack sections.
    try { json({ ok: true, packs: await iconPackStore.list() }); } catch (e) { err500(e.message); }
  },

  'POST /sound-pack': async (req, res, { json }, { soundPackStore }) => {
    // Install a soundboard pack (the 'sounds' preset kind). Reached only from
    // the import preview's Apply step. Validation is fail-closed in
    // sound-packs.js (per-clip magic bytes, id charsets, size caps); clips land
    // under DETERMINISTIC server-derived names (packs/<id>/<clip>.<ext>) so
    // shared Deck profiles can reference them across machines.
    try {
      const body = await readBodyBuffer(req, SOUND_PACK_BODY_MAX);
      let payload = null;
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; }
      const result = await soundPackStore.install(payload);
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      json(result);
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
  },
};

module.exports = { branches };
