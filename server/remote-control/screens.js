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

function createScreens({ probe, getSelected = () => '', runner = defaultRunner, exe = DXGI_INFO } = {}) {
  // Probe di default: rileva i monitor a runtime via dxgi-info.exe (dinamico,
  // riflette sempre i display attualmente collegati). Iniettabile per i test.
  const realProbe = probe || (async () => {
    const r = await runner.run(exe, []);
    if (!r || r.code !== 0) return [];
    return dxgiToScreens(parseDxgiInfo(r.stdout));
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

module.exports = { createScreens, parseDxgiInfo, dxgiToScreens, DXGI_INFO };
