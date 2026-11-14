// The captures kept on this computer: the list, a file, its small picture, its transcript, the
// export and the spots saved.

const { KINDS: CAPTURE_KINDS, VIDEO_KINDS } = require('../captures.js');
const TranscriptFormat = require('../transcript-format.js');
const fileTransferLib = require('../file-transfer.js');
const { readBody, readBodyBuffer } = require('../http/read-body.js');
const fs = require('node:fs');
const { serveFileRange } = require('../http-range.js');
const CaptureCovers = require('../capture-covers.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { revealInFileManager } = require('../files/reveal-in-file-manager.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /captures': async (_req, _res, { json, err500, urlObj }, { _captureExport, _captureHost, _captures, _transcripts, layersHost, remoteAccess, transferEnabled }) => {
    // The gallery: a page of captures, newest first, with ids and names only
    // (captures.js keeps the paths). Readable from a paired phone, which may
    // look and download; deleting, trimming, copying and "show in folder" are
    // the PC's (REMOTE_DENY).
    try {
      const q = urlObj.searchParams;
      const page = await _captures.browse({
        kind: q.get('kind') || '', game: q.get('game') || '',
        before: q.get('before'), limit: q.get('limit'),
      });
      const first = !(Number(q.get('before')) > 0);
      // A video with its words written down says so (capture-transcripts.js).
      const entries = page.entries.map(e => (_transcripts.has(e.id) ? { ...e, transcript: true } : e));
      json({
        ok: true, ...page, entries,
        ...(first ? { games: _captures.games(), usedBytes: await _captures.usage(CAPTURE_KINDS) } : {}),
        editable: _captureHost.available(),
        // What this engine can do (the macOS one makes no shareable copies and
        // finds no private data; a Linux one without ffmpeg cannot trim):
        // hidden, not refused.
        can: {
          trim: _captureHost.has('trim'),
          copy: _captureHost.has('copy_files'),
          export: _captureHost.has('export'),
          cover: _captureHost.has('cover'),
          speech: _captureHost.has('speech'),
        },
        // A screenshot can be pinned over every window (capabilities/screen-pin.js).
        pinnable: layersHost.available(),
        // "To phone" needs the file transfer on and a paired phone to see it.
        sendable: transferEnabled() && remoteAccess.count() > 0,
        transcribing: _transcripts.status().working || '',
        // A copy being made (capture-export.js), for a gallery opened halfway.
        exporting: _captureExport.status(),
      });
    } catch (e) { err500(e.message); }
  },

  'GET /captures/transcript': async (req, res, { json, err500, urlObj }, { _captures, _transcripts }) => {
    // A video's transcript by opaque id: the lines and chapters for the
    // gallery, or a subtitle file (`format=srt|vtt`). Readable from a paired
    // phone like the video itself; making one is the PC's (/captures/transcribe).
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      res.writeHead(403); res.end(); return;
    }
    try {
      const id = urlObj.searchParams.get('id') || '';
      const e = _captures.get(id);
      const t = e ? await _transcripts.read(e.id) : null;
      const format = urlObj.searchParams.get('format') || 'json';
      if (format === 'json') { json(t ? { ok: true, ...t } : { ok: false, error: e ? 'no_transcript' : 'not_found' }); return; }
      if (!t || (format !== 'srt' && format !== 'vtt')) { res.writeHead(404); res.end(); return; }
      const body = Buffer.from(format === 'srt' ? TranscriptFormat.toSrt(t.lines) : TranscriptFormat.toVtt(t.lines), 'utf8');
      res.writeHead(200, {
        'Content-Type': format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8',
        'Content-Length': String(body.length),
        'Content-Disposition': fileTransferLib.contentDisposition(e.name.replace(/\.[^.]+$/, '') + '.' + format),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (e) { err500(e.message); }
  },

  'POST /captures/transcribe': async (req, _res, { json, err500 }, { _transcripts }) => {
    // Starts writing down what is said in a video; answers at once, progress
    // and the end come over SSE `transcript`. The PC's only (REMOTE_DENY).
    try {
      const body = JSON.parse(await readBody(req, 1024) || '{}');
      const r = await _transcripts.start(String((body && body.id) || ''));
      json(r.ok ? { ok: true, working: true } : r);
    } catch (e) { err500(e.message); }
  },

  'POST /captures/export': async (req, _res, { json, err500 }, { _captureExport }) => {
    // A copy of a video for sharing (vertical, fitted to a size, GIF): answers
    // at once, progress and the end come over SSE `capture_export`. The PC's
    // only (REMOTE_DENY + CSRF).
    try {
      const body = JSON.parse(await readBody(req, 1024) || '{}') || {};
      const r = await _captureExport.start(String(body.id || ''), {
        kind: body.kind, focus: body.focus, webcam: body.webcam === true, mb: body.mb,
      });
      json(r.ok ? { ok: true, working: true, kind: r.kind } : r);
    } catch (e) { err500(e.message); }
  },

  'POST /captures/export-cancel': async (_req, _res, { json, err500 }, { _captureExport }) => {
    // Stops the copy being made; nothing is left on disk.
    try { json(await _captureExport.cancel()); } catch (e) { err500(e.message); }
  },

  'GET /captures/thumb': async (req, res, { err500, urlObj }, { _captureGallery }) => {
    // A capture's preview (JPEG made by the engine, cached under DATA_DIR).
    // 404 = none: the gallery draws the kind's icon instead.
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      res.writeHead(403); res.end(); return;
    }
    try {
      const file = await _captureGallery.thumb(urlObj.searchParams.get('id') || '');
      if (!file) { res.writeHead(404); res.end(); return; }
      const body = await fs.promises.readFile(file);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(body.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        // An id never names another file: a trim is a new capture.
        'Cache-Control': 'private, max-age=86400',
      });
      res.end(body);
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }
  },

  'GET|HEAD /captures/file': async (req, res, { err500, urlObj }, { _captures }) => {
    // The capture itself, by opaque id, with Range for the player's seeking;
    // `dl=1` asks the browser to save it. Same shape as /api/transfer/file:
    // no caller-supplied path exists to contain. Not CSRF-listed: a pure read,
    // and Download is a top-level navigation.
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      res.writeHead(403); res.end(); return;
    }
    try {
      const e = _captures.get(urlObj.searchParams.get('id') || '');
      if (!e) { res.writeHead(404); res.end(); return; }
      const stat = await fs.promises.stat(e.file);
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }
      const disposition = fileTransferLib.contentDisposition(e.name);
      serveFileRange(req, res, e.file, stat, {
        'Content-Type': VIDEO_KINDS.includes(e.kind) ? 'video/mp4' : e.kind === 'gif' ? 'image/gif' : 'image/png',
        'Content-Disposition': urlObj.searchParams.get('dl') === '1' ? disposition : disposition.replace(/^attachment/, 'inline'),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      });
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }
  },

  'POST /captures/spots': async (req, _res, { json, err500 }, { _captureCovers }) => {
    // The gallery's editor: where a screenshot shows an e-mail, an IBAN or a
    // long number (rectangles only, never the text). Loopback-only.
    try {
      const body = JSON.parse(await readBody(req, 1024) || '{}');
      json(await _captureCovers.spots(String((body && body.id) || '')));
    } catch (e) { err500(e.message); }
  },

  'POST /captures/save': async (req, _res, { json, err500, urlObj }, { _captureCovers }) => {
    // The editor's drawing as a new screenshot beside the original: the body is
    // the PNG itself, the id in the query. Loopback-only, CSRF-checked.
    try {
      const id = String(urlObj.searchParams.get('id') || '');
      let png;
      try { png = await readBodyBuffer(req, CaptureCovers.MAX_PNG_BYTES); } catch (e) {
        if (e.code === 'PAYLOAD_TOO_LARGE') { json({ ok: false, error: 'too_large' }); return; }
        throw e;
      }
      const r = await _captureCovers.save(id, png);
      if (r.ok) broadcastSSE('captures', { changed: true });
      json(r);
    } catch (e) { err500(e.message); }
  },

  'POST /captures/delete|/captures/reveal|/captures/copy|/captures/trim': async (req, _res, { json, err500, reqPath }, { _captureGallery, _captures }) => {
    // delete / reveal / copy / trim, by id. Loopback-only (REMOTE_DENY) and in
    // CSRF_MUTATION_PATHS: each one acts on a file on this PC.
    try {
      const body = JSON.parse(await readBody(req, 1024) || '{}');
      const id = String((body && body.id) || '');
      let r;
      if (reqPath === '/captures/delete') r = await _captures.remove(id);
      else if (reqPath === '/captures/trim') r = await _captureGallery.trim(id, { start: body.start, end: body.end });
      else if (reqPath === '/captures/copy') r = await _captureGallery.copy(id);
      else {
        const e = _captures.get(id);
        if (e) revealInFileManager(e.file);
        r = e ? { ok: true } : { ok: false, error: 'not_found' };
      }
      // Every open gallery (a phone's too) shows the change.
      if (r.ok && (reqPath === '/captures/delete' || reqPath === '/captures/trim')) broadcastSSE('captures', { changed: true });
      json(r);
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
