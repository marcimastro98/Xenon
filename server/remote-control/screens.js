'use strict';

const defaultRunner = require('./runner');

// Strumento ufficiale di Sunshine che elenca i display realmente collegati e il
// loro Output Name (esattamente l'id accettato da /api/config output_name).
const DXGI_INFO = 'C:\\Program Files\\Sunshine\\tools\\dxgi-info.exe';

// Parsa l'output di dxgi-info.exe. Formato (per adapter, 0+ output):
//   ====== ADAPTER ======
//   Device Name       : NVIDIA GeForce RTX 5080
//       ====== OUTPUT ======
//       Output Name       : \\.\DISPLAY1
//       AttachedToDesktop : yes
//       Resolution        : 3840x2160
// Ritorna [{ id, adapter, attached, resolution }].
function parseDxgiInfo(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const outputs = [];
  let adapter = '';
  let pending = null;
  const flush = () => { if (pending && pending.id) outputs.push(pending); pending = null; };

  for (const line of lines) {
    const t = line.trim();
    let m;
    if (/^=+\s*ADAPTER/i.test(t)) { flush(); adapter = ''; continue; }
    if ((m = t.match(/^Device Name\s*:\s*(.+)$/i))) { adapter = m[1].trim(); continue; }
    if (/^=+\s*OUTPUT/i.test(t)) { continue; }
    if ((m = t.match(/^Output Name\s*:\s*(.+)$/i))) {
      flush();
      pending = { id: m[1].trim(), adapter, attached: false, resolution: '' };
      continue;
    }
    if (pending && (m = t.match(/^AttachedToDesktop\s*:\s*(.+)$/i))) {
      pending.attached = /^(yes|true)/i.test(m[1].trim());
      continue;
    }
    if (pending && (m = t.match(/^Resolution\s*:\s*(.+)$/i))) {
      pending.resolution = m[1].trim();
      continue;
    }
  }
  flush();
  return outputs;
}

// Trasforma il parse in [{ id, name, primary }] per i soli monitor TRASMETTIBILI.
// Windows cattura lo schermo solo dalla GPU che pilota quel display, e Sunshine
// (adapter automatico) usa la GPU primaria. Quindi sono trasmettibili solo i
// monitor sulla STESSA GPU del primo display attivo (= GPU primaria, primo
// adapter in ordine DXGI). I monitor su una seconda GPU non sono catturabili
// (forzarli fa cadere lo stream) e vengono esclusi. Generico, nessun hardcoding:
// su un PC con una sola GPU restano tutti i monitor.
function dxgiToScreens(parsed) {
  const attached = (parsed || []).filter((o) => o.attached);
  if (attached.length === 0) return [];
  const primaryAdapter = attached[0].adapter;
  return attached
    .filter((o) => o.adapter === primaryAdapter)
    .map((o) => {
      const short = o.id.replace(/^\\\\\.\\/, ''); // \\.\DISPLAY1 -> DISPLAY1
      const name = o.resolution ? `${short} · ${o.resolution}` : short;
      return { id: o.id, name, primary: false };
    });
}

// ── Linux ────────────────────────────────────────────────────────────────────
// There is no dxgi-info off Windows, and no need for one: the kernel already
// publishes every connector under /sys/class/drm, and the connector NAME is
// exactly the identifier Sunshine's KMS capture takes as `output_name`.
//
// Reading a directory beats shelling out to xrandr here — xrandr is X11-only,
// and this machine (like most current desktops) is Wayland, where it reports
// nothing useful. /sys is the same answer under both.
//
// Measured on the port machine:
//   card1-eDP-1     status=connected    enabled=enabled   modes: 1920x1080
//   card1-HDMI-A-1  status=disconnected enabled=disabled
const DRM_DIR = '/sys/class/drm';

function drmToScreens(entries) {
  return (entries || [])
    // `connected` — a display is physically attached — and NOT `enabled`.
    //
    // The first version filtered on both, which looked more precise and was
    // wrong: `enabled` tracks the live modeset, so it flips to `disabled` the
    // moment the screen blanks. Caught by running this on the port machine
    // twice a few minutes apart — the laptop panel went to DPMS Off between
    // the two, and the monitor list went from one entry to none. That would
    // have emptied the picker, and dropped the user's chosen screen, every
    // time the display slept.
    .filter((e) => e.connected)
    .map((e) => ({
      id: e.name,
      name: e.resolution ? `${e.name} · ${e.resolution}` : e.name,
      primary: false,
    }));
}

function readDrmConnectors(fsImpl) {
  let names = [];
  try { names = fsImpl.readdirSync(DRM_DIR); } catch { return []; }
  const out = [];
  for (const dir of names) {
    // cardN-CONNECTOR; the card prefix is the GPU and is not part of the name
    // Sunshine wants.
    const m = /^card\d+-(.+)$/.exec(dir);
    if (!m) continue;
    const read = (f) => {
      try { return String(fsImpl.readFileSync(`${DRM_DIR}/${dir}/${f}`, 'utf8')).trim(); }
      catch { return ''; }
    };
    out.push({
      name: m[1],
      connected: read('status') === 'connected',
      enabled: read('enabled') === 'enabled',
      resolution: (read('modes').split('\n')[0] || '').trim(),
    });
  }
  return out;
}

function createScreens({
  probe, getSelected = () => '', runner = defaultRunner, exe = DXGI_INFO,
  platform = process.platform, fsImpl = require('node:fs'),
} = {}) {
  // Probe di default: rileva i monitor a runtime (dinamico, riflette sempre i
  // display attualmente collegati). Iniettabile per i test.
  const realProbe = probe || (async () => {
    if (platform === 'win32') {
      const r = await runner.run(exe, []);
      if (!r || r.code !== 0) return [];
      return dxgiToScreens(parseDxgiInfo(r.stdout));
    }
    // macOS has neither DXGI nor DRM: Sunshine identifies displays by index
    // there, and there is no supported way to enumerate them from outside the
    // app. An empty list is honest — the panel then shows no screen picker
    // rather than a wrong one, and capture stays on Sunshine's own default.
    if (platform === 'darwin') return [];
    return drmToScreens(readDrmConnectors(fsImpl));
  });

  async function list() {
    const raw = await realProbe();
    const sel = getSelected();
    return (Array.isArray(raw) ? raw : []).map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id),
      primary: m.primary === true,
      active: String(m.id) === String(sel),
    }));
  }

  async function nextId() {
    const items = await list();
    if (items.length === 0) return '';
    const idx = items.findIndex((m) => m.active);
    const next = items[(idx + 1) % items.length] || items[0];
    return next.id;
  }

  return { list, nextId };
}

module.exports = {
  createScreens, parseDxgiInfo, dxgiToScreens, DXGI_INFO,
  readDrmConnectors, drmToScreens, DRM_DIR,
};
