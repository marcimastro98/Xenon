// What the engine does with a picture uploaded to decorate one tile.

const { readBodyBuffer } = require('../http/read-body.js');
const { TILE_ASSET_MAX_BYTES, TILE_ASSET_MIME_BY_EXT } = require('../http/upload-limits.js');
const { parseMultipartBackground } = require('../http/multipart-upload.js');
const path = require('node:path');
const fs = require('node:fs');
const { UPLOADS_DIR } = require('../engine/uploads-dir.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /tile-asset': async (req, res, { json }, { TILE_ASSET_EXT_BY_MIME }) => {
    // Manual per-tile decoration upload. Mirrors /background but keeps every file
    // (multiple tiles → multiple pictures); a `tileasset-*` name is server-generated
    // and orphans are reclaimed by cleanupUnreferencedTileAssets() on layout save.
    try {
      const body = await readBodyBuffer(req, TILE_ASSET_MAX_BYTES);
      const file = parseMultipartBackground(req, body, 'asset');
      const extFromName = path.extname(file.originalName).toLowerCase();
      const ext = TILE_ASSET_MIME_BY_EXT.has(extFromName) ? extFromName : TILE_ASSET_EXT_BY_MIME.get(file.contentType);
      if (!ext || !TILE_ASSET_MIME_BY_EXT.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      const expectedType = TILE_ASSET_MIME_BY_EXT.get(ext);
      if (file.contentType && file.contentType !== 'application/octet-stream' && file.contentType !== expectedType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File type mismatch' }));
        return;
      }
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      const safeName = `tileasset-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      await fs.promises.writeFile(path.join(UPLOADS_DIR, safeName), file.data);
      json({ ok: true, url: `/uploads/${safeName}`, name: file.originalName, type: expectedType, size: file.data.length });
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
