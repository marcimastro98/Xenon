'use strict';

// ── Rendering-GPU hint (Settings → Performance) ─────────────────────────────
// Surfaces which GPU the browser renders the dashboard on (WebGL unmasked
// renderer). On a laptop the browser usually picks the discrete GPU while the
// Xeneon Edge is driven by the integrated GPU, so every frame is copied
// cross-adapter and the discrete GPU never idles. We can't change the user's
// default-browser GPU for them, so we show the detected GPU and — when it looks
// discrete — explain the one-time Windows setting that pins the browser to the
// integrated GPU. Purely informational; it never touches rendering.
(function () {
  // The renderer string comes from the graphics driver; render it via textContent
  // only (set below), never as markup.
  function detectRenderer() {
    let gl = null;
    try {
      const canvas = document.createElement('canvas');
      gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return '';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const raw = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return String(raw || '').trim();
    } catch {
      return '';
    } finally {
      // Release the throwaway context promptly instead of waiting for GC.
      try { const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch { /* ignore */ }
    }
  }

  // Heuristic: does the renderer look like a discrete GPU worth pinning? Kept
  // conservative — an integrated Intel/AMD GPU is already the low-power path, so
  // we don't nudge those. Intel Arc and AMD RX are discrete and do qualify.
  function looksDiscrete(name) {
    const s = name.toLowerCase();
    if (/intel/.test(s) && !/\barc\b/.test(s)) return false;                 // Intel iGPU
    if (/(radeon|amd)/.test(s) && /(vega|graphics)/.test(s) && !/\brx\b/.test(s)) return false; // AMD APU iGPU
    return /(nvidia|geforce|\brtx\b|\bgtx\b|quadro|radeon|\brx\b|\barc\b)/.test(s);
  }

  function apply() {
    const group = document.getElementById('settings-gpu-group');
    if (!group) return;
    const name = detectRenderer();
    if (!name) { group.hidden = true; return; }   // no reliable read → show nothing
    group.hidden = false;
    const nameEl = document.getElementById('settings-gpu-name');
    if (nameEl) nameEl.textContent = name;
    const tip = document.getElementById('settings-gpu-tip');
    if (tip) tip.hidden = !looksDiscrete(name);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }
})();
