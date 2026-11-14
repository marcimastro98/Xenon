'use strict';
// The graphics cards of a Mac read from the JSON system_profiler gives for its displays.

function parseDisplaysJson(raw) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return { gpuName: null, vramTotal: null }; }
  const list = doc && Array.isArray(doc.SPDisplaysDataType) ? doc.SPDisplaysDataType : [];
  // Switchable-graphics Intel Macs list BOTH GPUs, and the integrated one can
  // come first. The discrete card is the one with dedicated VRAM — an iGPU
  // only ever reports spdisplays_vram_shared — so it wins over a first-listed
  // iGPU instead of taking whatever enumeration order gives. Apple Silicon
  // lists exactly one entry and is untouched by the preference.
  let card = null;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (!card || (String(c.spdisplays_vram || '').trim() && !String(card.spdisplays_vram || '').trim())) card = c;
  }
  if (!card) return { gpuName: null, vramTotal: null };
  const gpuName = String(card.sppci_model || card._name || '').trim() || null;
  // Discrete cards report e.g. "8 GB"; Apple Silicon reports nothing at all
  // because the GPU shares system memory -- null is the honest answer there.
  const vramRaw = String(card.spdisplays_vram || card.spdisplays_vram_shared || '').trim();
  const m = vramRaw.match(/^(\d+(?:\.\d+)?)\s*(MB|GB)$/i);
  const vramTotal = m
    ? Math.round(Number(m[1]) * (m[2].toUpperCase() === 'GB' ? 1073741824 : 1048576))
    : null;
  return { gpuName, vramTotal };
}

module.exports = { parseDisplaysJson };
