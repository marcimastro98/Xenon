// What the engine does for the look of the dashboard: a background uploaded and a font
// uploaded.

const { readBodyBuffer } = require('../http/read-body.js');
const {
  BACKGROUND_MAX_BYTES, BACKGROUND_MIME_BY_EXT, FONT_MAX_BYTES, FONT_MIME_BY_EXT,
} = require('../http/upload-limits.js');
const { parseMultipartBackground } = require('../http/multipart-upload.js');
const path = require('node:path');
const fs = require('node:fs');
const { UPLOADS_DIR } = require('../engine/uploads-dir.js');
const { cleanupOldBackgrounds, cleanupOldFonts } = require('./upload-cleanup.js');
const { isFfmpegMissing } = require('../ffmpeg-install/lookup.js');
const { serveFileRange } = require('../http-range.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /background': async (req, res, { json }, { BACKGROUND_EXT_BY_MIME, transcodeMp4BackgroundToWebm }) => {
    try {
      const body = await readBodyBuffer(req, BACKGROUND_MAX_BYTES);
      const file = parseMultipartBackground(req, body);
      const extFromName = path.extname(file.originalName).toLowerCase();
      const ext = BACKGROUND_MIME_BY_EXT.has(extFromName) ? extFromName : BACKGROUND_EXT_BY_MIME.get(file.contentType);
      if (!ext || !BACKGROUND_MIME_BY_EXT.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      const expectedType = BACKGROUND_MIME_BY_EXT.get(ext);
      if (file.contentType && file.contentType !== 'application/octet-stream' && file.contentType !== expectedType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File type mismatch' }));
        return;
      }
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      const safeName = `background-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      const safePath = path.join(UPLOADS_DIR, safeName);
      await fs.promises.writeFile(safePath, file.data);

      let response = { ok: true, url: `/uploads/${safeName}`, name: file.originalName, type: expectedType, size: file.data.length, conversion: 'not-needed' };
      if (expectedType === 'video/mp4') {
        const webmName = safeName.replace(/\.mp4$/i, '.webm');
        const webmPath = path.join(UPLOADS_DIR, webmName);
        try {
          const webmStat = await transcodeMp4BackgroundToWebm(safePath, webmPath);
          await fs.promises.unlink(safePath).catch(() => {});
          response = {
            ok: true,
            url: `/uploads/${webmName}`,
            name: `${path.basename(file.originalName, path.extname(file.originalName))}.webm`,
            type: 'video/webm',
            size: webmStat.size,
            originalName: file.originalName,
            originalType: expectedType,
            converted: true,
            conversion: 'webm-vp8',
          };
          cleanupOldBackgrounds(webmName);
        } catch (conversionError) {
          await fs.promises.unlink(webmPath).catch(() => {});
          response = {
            ...response,
            conversion: isFfmpegMissing(conversionError) ? 'ffmpeg-missing' : 'failed',
          };
          console.warn(`Background MP4 conversion skipped: ${conversionError.message}`);
          cleanupOldBackgrounds(safeName);
        }
      } else {
        cleanupOldBackgrounds(safeName);
      }

      json(response);
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

  'POST /font': async (req, res, { json }, { FONT_EXT_BY_MIME }) => {
    try {
      const body = await readBodyBuffer(req, FONT_MAX_BYTES);
      const file = parseMultipartBackground(req, body, 'font');
      // Fonts are validated by EXTENSION (the served MIME + how the browser loads
      // them derive from it). Content-Type is only a soft hint — browsers report
      // fonts inconsistently (font/woff2, application/octet-stream, empty) — so it
      // never rejects on its own; the extension allowlist + server-generated name
      // are the real controls, exactly like the durable-upload invariant.
      const extFromName = path.extname(file.originalName).toLowerCase();
      const ext = FONT_MIME_BY_EXT.has(extFromName) ? extFromName : FONT_EXT_BY_MIME.get(file.contentType);
      if (!ext || !FONT_MIME_BY_EXT.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      const safeName = `font-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      await fs.promises.writeFile(path.join(UPLOADS_DIR, safeName), file.data);
      cleanupOldFonts(safeName);
      json({ ok: true, url: `/uploads/${safeName}`, name: file.originalName, size: file.data.length });
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

  'DELETE /font/*': async (_req, res, { json, err500, reqPath }) => {
    // Imported-theme cleanup. Only a generated font filename inside UPLOADS_DIR
    // is accepted; arbitrary uploads and paths remain unreachable.
    try {
      const name = decodeURIComponent(reqPath.slice('/font/'.length));
      if (!/^[A-Za-z0-9._-]+\.(?:woff2?|ttf|otf)$/i.test(name)) { res.writeHead(400); res.end(); return; }
      const abs = path.join(UPLOADS_DIR, name);
      if (!abs.startsWith(UPLOADS_DIR + path.sep)) { res.writeHead(400); res.end(); return; }
      await fs.promises.rm(abs, { force: true });
      json({ ok: true });
    } catch (e) { err500(e.message); }
  },

  'GET /uploads/*': async (req, res, { err500, reqPath }) => {
    try {
      const name = decodeURIComponent(reqPath.slice('/uploads/'.length));
      if (!/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(403); res.end('Forbidden'); return; }
      const abs = path.join(UPLOADS_DIR, name);
      const ext = path.extname(name).toLowerCase();
      const mime = BACKGROUND_MIME_BY_EXT.get(ext) || FONT_MIME_BY_EXT.get(ext);
      if (!mime) { res.writeHead(404); res.end(); return; }
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }

      serveFileRange(req, res, abs, stat, {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }
  },
};

module.exports = { branches };
