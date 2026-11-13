// What the engine answers about captures: a screenshot of the screens or of one monitor, the
// capture settings and the folder picked for them, clips cut from the marks of a video, and a
// capture sent to the phone.

const { listScreens } = require('./list-screens.js');
const { readBody } = require('../http/read-body.js');
const CaptureSettings = require('../capture-settings.js');
const { captureOptions } = require('./capture-options.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/screenshot': async (_req, res, { urlObj }, { captureScreenshot }) => {
    try {
      // Same capture the AI's vision tool uses — one implementation, so the
      // per-platform grabber lives in exactly one place.
      const w = parseInt(urlObj.searchParams.get('w'));
      const h = parseInt(urlObj.searchParams.get('h'));
      const monitor = w > 0 && h > 0
        ? {
            x: parseInt(urlObj.searchParams.get('x')) || 0,
            y: parseInt(urlObj.searchParams.get('y')) || 0,
            width: w,
            height: h,
          }
        : null;
      const base64 = await captureScreenshot(monitor);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ base64, mimeType: 'image/jpeg' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  },

  'GET /api/screenshot/monitor': async (_req, res, { json, urlObj }, { captureScreenshot }) => {
    // "Share my setup": capture exactly ONE enumerated display, near native res.
    //
    // The client names an INDEX, never a rectangle — the server re-derives the
    // bounds from its own listScreens(), so this cannot become an arbitrary-
    // region capture primitive (unlike /api/screenshot, whose x/y/w/h contract
    // the AI vision flow depends on). The response echoes the screen it used so
    // the client can verify the display did not change under it mid-capture.
    if (process.platform !== 'win32') {
      // gdigrab is Windows-only. Answer immediately instead of burning the 15 s
      // ffmpeg timeout, so the card falls back to its drawn form fast.
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported' }));
      return;
    }
    try {
      const idx = Number.parseInt(urlObj.searchParams.get('index'), 10);
      const screens = await listScreens();
      const s = (Number.isInteger(idx) && idx >= 0 && idx < screens.length) ? screens[idx] : null;
      if (!s || !(s.width > 0) || !(s.height > 0)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown monitor' }));
        return;
      }
      const max = Number.parseInt(urlObj.searchParams.get('max'), 10);
      const base64 = await captureScreenshot(s, { maxWidth: max || 2560, quality: 2 });
      json({ base64, mimeType: 'image/jpeg', screen: { index: s.index, width: s.width, height: s.height } });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  },

  'POST /captures/clips': async (req, _res, { json, err500 }, { makeMarkClips }) => {
    // "Clips from marks": a short copy around each marked moment of a video
    // (capture-gallery.js clips()). Like a trim: CSRF-checked, the original kept.
    try {
      const body = JSON.parse(await readBody(req, 1024) || '{}');
      json(await makeMarkClips(String((body && body.id) || ''), body && body.which));
    } catch (e) { err500(e.message); }
  },

  'POST /captures/send': async (req, _res, { json, err500 }, { sendCaptureToPhone }) => {
    // "To phone": the capture joins the PC → phone file list (capture-send.js).
    // Loopback-only and CSRF-checked: the phone downloads, the PC sends.
    try {
      const body = JSON.parse(await readBody(req, 1024) || '{}');
      json(await sendCaptureToPhone(String((body && body.id) || '')));
    } catch (e) { err500(e.message); }
  },

  'POST /capture/settings': async (req, _res, { json, err500 }, { updateCaptureSettings }) => {
    // Frame rate, size, quality, pill, space limit; `folder: ''` (or
    // shotFolder, benchFolder) goes back to the default folder. A folder is only
    // set through /capture/settings/pick.
    // Loopback-only (REMOTE_DENY), in CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      const { bad, owner } = CaptureSettings.applyCaptureChange(captureOptions(), body);
      if (bad.length) { json({ ok: false, error: owner ? 'reserved' : 'bad_value', bad, ...(owner ? { owner } : {}) }); return; }
      const resets = {};
      for (const key of CaptureSettings.FOLDER_KEYS) if (body[key] === '') resets[key] = '';
      const saved = await updateCaptureSettings(body, resets);
      json({ ok: true, ...saved });
    } catch (e) { err500(e.message); }
  },

  'POST /capture/settings/pick': async (req, _res, { json, err500 }, { _captureHost, chooseCaptureFolder, updateCaptureSettings }) => {
    // The system's folder dialog, on the PC. Waits for the choice (the engine
    // closes a forgotten dialog after 5 minutes). Loopback-only, CSRF-listed.
    try {
      if (!_captureHost.has('pick_folder')) { json({ ok: false, error: 'unavailable' }); return; }
      const body = JSON.parse(await readBody(req, 1024) || '{}');
      const key = CaptureSettings.FOLDERS[body && body.for] || CaptureSettings.FOLDERS.recording;
      const kind = Object.keys(CaptureSettings.FOLDERS).find((k) => CaptureSettings.FOLDERS[k] === key);
      const r = await chooseCaptureFolder(kind);
      if (!r.ok || r.cancelled) { json(r); return; }
      const saved = await updateCaptureSettings({}, { [key]: r.path });
      json({ ok: true, [key]: saved[key] });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
