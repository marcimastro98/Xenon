// What the engine answers about the lights: the state of the lighting, its devices, the album
// colours, an event, the download page and the install of the iCUE kit, and SignalRGB.

const lighting = require('../lighting.js');
const { readBody } = require('../http/read-body.js');
const { execFile } = require('node:child_process');
const icueSdkInstall = require('../icue-sdk-install.js');
const { hub } = require('../settings/current.js');
const signalrgb = require('../signalrgb.js');
const { withHubSettingsLock } = require('../settings/write-lock.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/lighting/status': async (_req, _res, { json }) => {
    try {
      // If the session is up but the device list looks incomplete — empty, or a
      // device enumerated with 0 LEDs (the iCUE LINK hub reports 0 until iCUE
      // finishes registering the cooler/fans behind it, common right after a boot)
      // — kick a throttled, bounded re-enumeration so a follow-up status refresh
      // (and the next paint) see the real LED layout.
      if (lighting.isConnected()) {
        Promise.resolve(lighting.boundedReenumerate()).catch(() => {});
      }
      json(lighting.getStatus());
    }
    catch (e) { json({ available: false, reason: e.message }); }
  },

  'GET /api/lighting/devices': async (_req, _res, { json }) => {
    // Flat device list for the Deck editor's per-device lighting picker:
    // [{ value: id, label }] — iCUE devices plus every external-provider device.
    try {
      const ls = lighting.getStatus();
      const out = [];
      (ls.devices || []).forEach((dv) => out.push({ value: dv.id, label: dv.name || dv.model || dv.id }));
      (ls.providers || []).forEach((p) => (p.devices || []).forEach((dv) => out.push({ value: dv.id, label: (p.name ? p.name + ' · ' : '') + (dv.name || dv.id) })));
      // The parts of each device with a map, for the "colour one part" picker;
      // the editor names them the way the lighting map does.
      const parts = (ls.devices || []).filter(dv => (dv.segments || []).length > 1).map(dv => ({
        device: dv.id, label: dv.model || dv.id,
        segments: dv.segments.map(sg => ({ kind: sg.kind, output: sg.output, piece: sg.piece, name: sg.name })),
      }));
      json({ devices: out, parts });
    } catch (e) { json({ devices: [] }); }
  },

  'POST /api/lighting/album': async (req, _res, { json }) => {
    // Live now-playing cover colour from the client. Transient (not persisted),
    // like the manual override; the bridge ignores it when the effect is off.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body && body.clear) { lighting.clearAlbum(); json({ ok: true }); }
      else json({ ok: lighting.setAlbumColor(body && body.color, body && body.palette) });
    } catch (e) { json({ ok: false, error: e.message }); }
  },

  'POST /api/lighting/event': async (req, _res, { json }) => {
    // Client-originated event flash (reminder / notification). Timer is fired
    // server-side from _checkTimers. Never throws; unknown/disabled type = no-op.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      lighting.onEvent(String(body && body.type || ''));
      json({ ok: true });
    } catch (e) { json({ ok: false, error: e.message }); }
  },

  'POST /api/lighting/open-download': async (req, _res, { json }) => {
    // Open a provider's official download page in the default browser. The URL is
    // resolved server-side from the provider catalogue, never taken from the client.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const provider = String(body && body.provider || '');
      const entry = lighting.getExternalStatus().providers.find(p => p.id === provider);
      const url = entry && entry.download;
      if (url && /^https:\/\//i.test(url)) {
        execFile('cmd', ['/c', 'start', '', url], () => {});
        json({ ok: true, url });
      } else {
        json({ ok: false, error: 'no download url' });
      }
    } catch (e) { json({ ok: false, error: e.message }); }
  },

  'POST /api/lighting/sdk-install': async (_req, _res, { json }) => {
    // Fetches the CORSAIR iCUE SDK client component from Corsair's official
    // release (pinned version + SHA-256, both in icue-sdk-update.ps1). The
    // installer does this too, but an existing install never re-runs it, so
    // without this button a self-updated install has no route to CORSAIR RGB.
    // Never throws: a failed fetch is a message the lighting page shows.
    try {
      const r = await icueSdkInstall.install();
      // The memoized DLL probe would keep reporting "missing" for its whole TTL.
      if (r.ok) lighting.refreshAvailability();
      json({ ok: r.ok, status: r.status, error: r.ok ? null : r.detail, lighting: lighting.getStatus() });
    } catch (e) { json({ ok: false, error: e.message }); }
  },

  'GET /api/signalrgb/status': async (_req, _res, { json }) => {
    // SignalRGB card in Settings → Lighting: whether the launcher is installed on
    // this PC and whether the user has enabled the integration. Windows-only;
    // elsewhere `installed` is simply false and the card shows the "not found" hint.
    const s = hub.settings || {};
    json({ ok: true, installed: signalrgb.isInstalled(), enabled: !!(s.signalrgb && s.signalrgb.enabled === true) });
  },

  'GET /api/signalrgb/effects': async (_req, _res, { json }) => {
    // Effect list for the Deck picker. Empty unless the integration is enabled AND
    // installed; the scan is async + cached in signalrgb.js so repeated opens of
    // the Deck editor don't re-walk the disk.
    try {
      const s = hub.settings || {};
      const enabled = !!(s.signalrgb && s.signalrgb.enabled === true);
      const effects = (enabled && signalrgb.isInstalled()) ? await signalrgb.scanEffects() : [];
      json({ ok: true, effects });
    } catch (e) {
      json({ ok: false, effects: [], error: String((e && e.message) || e) });
    }
  },

  'POST /api/signalrgb/config': async (req, _res, { json }, { writeHubSettings }) => {
    // Toggle the SignalRGB integration on/off (persisted like the chroma flag).
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      const enabled = body.enabled === true;
      await withHubSettingsLock(async () => {
        hub.settings = await writeHubSettings({ ...hub.settings, signalrgb: { enabled } });
      });
      signalrgb.clearCache();   // a fresh enable should re-scan, not serve a stale/empty list
      json({ ok: true, installed: signalrgb.isInstalled(), enabled });
    } catch (e) { json({ ok: false, error: (e && e.message) || 'save_failed' }); }
  },
};

module.exports = { branches };
