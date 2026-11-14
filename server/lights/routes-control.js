// What the engine does when the lighting is changed: an effect, a manual colour, an animation,
// the mode of a device, a scan, one device, the lights it drives directly with their layout and
// scan, and the Chroma link.

const { readBody } = require('../http/read-body.js');
const lighting = require('../lighting.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /api/lighting/effects': async (req, _res, { json, err500 }, { _persistLighting, _syncSessionWatch }) => {
    // Apply a partial config change immediately, then persist it so Lighting-page
    // (and AI-driven) toggles survive a server restart.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      lighting.applyConfig(body);
      _syncSessionWatch();
      // Enabling connects asynchronously — wait briefly so the response carries
      // the connected state and the freshly-enumerated device list.
      if (body && body.enabled === true) { try { await lighting.ensureConnected(); } catch {} }
      await _persistLighting();
      json(lighting.getStatus());
    } catch (e) { err500(e.message); }
  },

  'POST /api/lighting/manual': async (req, _res, { json, err500 }, { _persistLighting }) => {
    // Manual fixed colour — persisted so it survives a restart.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      let ok = true;
      if (body && body.clear) lighting.clearManual();
      else ok = lighting.setManualColor(body && body.color);
      await _persistLighting();
      json({ ok });
    } catch (e) { err500(e.message); }
  },

  'POST /api/lighting/animation': async (req, _res, { json, err500 }, { _persistLighting }) => {
    // Ambient animation (none|solid|breathing|cycle). Persisted so it survives a
    // restart. The render loop only spins while a dynamic style is actively painting.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      lighting.setAnimation(body);
      await _persistLighting();
      json(lighting.getStatus());
    } catch (e) { err500(e.message); }
  },

  'POST /api/lighting/device-mode': async (req, _res, { json, err500 }, { _persistLighting }) => {
    // Per-device override: { id, mode, color?, anim? }. Persisted.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = lighting.setDeviceMode(String(body && body.id || ''), body || {});
      await _persistLighting();
      json({ ok, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }
  },

  'POST /api/lighting/scan': async (_req, _res, { json, err500 }, { _persistLighting }) => {
    // On-demand LAN discovery for external providers (WLED, …). No background scan.
    try {
      const result = await lighting.scanExternal();
      await _persistLighting();
      json({ ok: true, found: result.found, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }
  },

  'POST /api/lighting/device': async (req, _res, { json, err500 }, { _persistLighting }) => {
    // Add / remove / opt-in an external device. body: { provider, action, host?, id?, optedIn? }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const provider = String(body && body.provider || '');
      const action = String(body && body.action || '');
      let result = { ok: false };
      if (action === 'add') {
        const dev = await lighting.addExternalDevice(provider, String(body.host || ''));
        result = { ok: !!dev, device: dev || null };
      } else if (action === 'pair') {
        const r = await lighting.pairExternalDevice(provider, String(body.host || ''));
        result = { ok: !!(r && r.ok), needsButton: !!(r && r.needsButton) };
      } else if (action === 'remove') {
        result = { ok: lighting.removeExternalDevice(provider, String(body.id || '')) };
      } else if (action === 'optin') {
        result = { ok: lighting.setExternalDeviceOptIn(provider, String(body.id || ''), body.optedIn !== false) };
      }
      await _persistLighting();
      json({ ...result, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }
  },

  'POST /api/lighting/native': async (req, _res, { json, err500 }, { _persistLighting, _syncSessionWatch }) => {
    // Native control of the motherboard's lighting on/off: { enabled }. Persisted.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      lighting.setNativeEnabled(body.enabled === true);
      _syncSessionWatch();
      await _persistLighting();
      json({ ok: true, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }
  },

  'POST /api/lighting/native/layout': async (req, res, { json, err500 }, { _persistLighting }) => {
    // What hangs on one output, from the guided setup:
    // { device, output, layout: { empty } | { parts: [{ kind, count, name? }] } | null }.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const output = Number(body.output);
      if (!Number.isInteger(output) || output < 0 || output > 15) { res.writeHead(400); res.end('Invalid output'); return; }
      const layout = body.layout === null ? null : (body.layout && typeof body.layout === 'object' ? body.layout : undefined);
      if (layout === undefined) { res.writeHead(400); res.end('Invalid layout'); return; }
      const ok = lighting.setNativeLayout(String(body.device || '').slice(0, 160), 'h' + output, layout);
      if (ok) await _persistLighting();
      json({ ok, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }
  },

  'POST /api/lighting/native/scan': async (_req, _res, { json, err500 }, { _persistLighting }) => {
    // Look for the controllers again (after plugging something in, or closing
    // the vendor app that held them).
    try {
      await lighting.scanNative();
      await _persistLighting();
      json({ ok: true, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }
  },

  'GET /api/chroma/status': async (_req, _res, { json }, { deckChroma }) => {
    // Chroma reachability + fixed device list (no live stream — state is static).
    json(deckChroma.getStatus());
  },

  'POST /api/chroma/test': async (_req, _res, { json }, { deckChroma }) => {
    // Settings "Test connection": init a Chroma session then release it.
    try { json(await deckChroma.test()); } catch (e) { json({ ok: false, error: 'chroma_failed' }); }
  },

  'POST /api/lighting/native/preview': async (req, _res, { json, err500 }) => {
    // Guided setup: light part of one output so the user sees where each fan
    // ends. { device, output, done: [counts], lit, whole } or { stop: true }.
    // Transient (ends by itself after a few seconds), never persisted.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.stop === true) { await lighting.setNativePreview('', 0, null); return json({ ok: true }); }
      const count = (n) => Math.max(0, Math.min(256, Math.round(Number(n)) || 0));
      const opts = {
        done: (Array.isArray(body.done) ? body.done : []).slice(0, 32).map(count),
        lit: count(body.lit),
        whole: body.whole === true,
      };
      const ok = await lighting.setNativePreview(String(body.device || '').slice(0, 160), Number(body.output), opts);
      json({ ok });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
