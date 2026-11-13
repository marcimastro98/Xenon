// What the engine answers about icon packs and sound packs, and where the automatic update of
// widgets stands.

const { readBodyBuffer } = require('../http/read-body.js');
const { ICON_PACK_BODY_MAX, SOUND_PACK_BODY_MAX } = require('../deck/pack-places.js');
const fs = require('node:fs');

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

  'GET /icon-pack/*': async (_req, res, { reqPath }, { iconPackStore }) => {
    // Serve one pack icon (/icon-pack/<packId>/<file>). Both segments are
    // regex-validated + prefix-asserted in icon-packs.js. The deny-all CSP +
    // nosniff keep an SVG inert even opened top-level — defense-in-depth on top
    // of the install-time reject-list.
    try {
      const parts = reqPath.slice('/icon-pack/'.length).split('/');
      const hit = parts.length === 2
        ? iconPackStore.resolve(decodeURIComponent(parts[0]), decodeURIComponent(parts[1]))
        : null;
      if (!hit) { res.writeHead(404); res.end(); return; }
      const data = await fs.promises.readFile(hit.abs);
      res.writeHead(200, {
        'Content-Type': hit.mime,
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  },

  'DELETE /icon-pack/*': async (_req, res, { json, err500, reqPath }, { iconPackStore }) => {
    // Uninstall a pack (Installed content cleanup). Id is regex-gated in
    // icon-packs.js; keys that embedded a pack icon keep their copy.
    try {
      const id = decodeURIComponent(reqPath.slice('/icon-pack/'.length));
      const ok = await iconPackStore.remove(id);
      if (!ok) { res.writeHead(400); res.end(); return; }
      json({ ok: true });
    } catch (e) { err500(e.message); }
  },

  'DELETE /sound-pack/*': async (_req, res, { json, err500, reqPath }, { soundPackStore }) => {
    // Uninstall a pack (Installed content cleanup). Deck keys referencing its
    // clips degrade to a no-op flash — same as any missing local file.
    try {
      const id = decodeURIComponent(reqPath.slice('/sound-pack/'.length));
      const ok = await soundPackStore.remove(id);
      if (!ok) { res.writeHead(400); res.end(); return; }
      json({ ok: true });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
