// Keeps thin lines sharp on a screen whose scale is not a whole number: zooms the page up to the
// next whole scale, and says how much in window.__pageZoom for code that places things by screen
// position.

(function () {
  // Effective page zoom (1 unless the Edge compensation below kicks in). Read by
  // code that positions fixed elements in client coordinates (e.g. the Deck drag
  // clone), since CSS `zoom` on <html> magnifies their inline px values.
  window.__pageZoom = 1;
  // In the native Tauri shell there is no iCUE resample to correct, and the shell
  // applies the user's own interface scale (WebView2 zoom, Settings + Ctrl-wheel).
  // WebView2 zoom changes the page's devicePixelRatio, so this fractional-DPR
  // compensation would COMPOUND with it (a chosen 150% could balloon to ~200%).
  // The shell owns scaling there — leave the page untouched.
  if (window.__XENON_NATIVE__ === true || window.isTauri === true) return;
  try {
    let appliedZoom = 1;                              // last zoom we wrote (1 = none)

    // SELF-HEAL (issue #53): when embedded in iCUE, a stale Qt screen association
    // (boot race with the USB display, or a DPI change on another monitor) makes the
    // widget rasterise at the PRIMARY monitor's scale — e.g. DPR 1.8 instead of the
    // correct 1.2 — and iCUE's downscale onto the panel blurs everything. The server
    // can fix it by nudging iCUE's Edge window 1px (Qt then re-reads the screen and
    // pushes the right scale, which fires our matchMedia listener below). Detect the
    // wrong-scale state and ask for the nudge. Correct DPR on the Edge is 1.2 (iCUE's
    // own 1.2 view zoom × the panel's 1.0 scale); anything ≥1.35 in the iCUE iframe
    // is a wrong-screen scale (1.2 × 1.25/1.5/1.75/2 = 1.5/1.8/2.1/2.4). Two attempts
    // max per bad state: if the DPR is genuinely correct the nudge changes nothing.
    const inIframe = (() => { try { return window.top !== window.self; } catch { return true; } })();
    let sharpenTries = 0;
    let sharpenAt = 0;
    const requestSharpen = (dpr, isWideBar) => {
      if (!inIframe || !isWideBar || dpr < 1.35) { sharpenTries = 0; return; }
      const now = Date.now();
      if (sharpenTries >= 2 || now - sharpenAt < 5000) return;
      sharpenTries++;
      sharpenAt = now;
      fetch('/api/icue/sharpen', { method: 'POST' }).catch(() => {});
    };

    const recompute = () => {
      if (!document.body) return;
      const dpr = window.devicePixelRatio || 1;
      const target = Math.max(1, Math.round(dpr));
      const isFractional = Math.abs(dpr - target) > 0.02;
      const isWideBar = (window.innerWidth / window.innerHeight) > 2.8;
      requestSharpen(dpr, isWideBar);
      // ONLY ever zoom UP (target > dpr, e.g. 1.8 → 2.0, z = 1.111…). Zooming DOWN
      // (when dpr rounds down, e.g. 1.2 → 1, z = 0.833) is a fractional DOWNSCALE of
      // the whole UI: it BLURS instead of sharpening, and at those DPRs the backing
      // surface is already ~the panel's native size, so the page renders crisp with
      // no zoom at all. Measured on the device: dpr 1.2 looks sharper untouched than
      // shrunk to effDpr 1.0. So below an integer we leave the page alone.
      const shouldZoom = isFractional && isWideBar && target > dpr;
      const z = shouldZoom ? (target / dpr) : 1;
      if (Math.abs(z - appliedZoom) < 0.0005) return; // nothing changed → no reflow
      appliedZoom = z;
      window.__pageZoom = z;
      if (z === 1) {
        // Back to a clean integer DPR (or no longer the bar) — drop the compensation
        // and restore the stylesheet defaults so a stale zoom can't blur the page.
        document.documentElement.style.zoom = '';
        document.body.style.width = '';
        document.body.style.height = '';
        document.body.style.minHeight = '';
      } else {
        document.documentElement.style.zoom = String(z);
        // Counter the zoom so 100% of the page still equals one physical screen.
        // vw/vh are relative to the UNZOOMED viewport, so (100/z)vw × z = 100vw.
        document.body.style.width = (100 / z) + 'vw';
        document.body.style.height = (100 / z) + 'vh';
        document.body.style.minHeight = '0';
      }
    };

    // Watch for DPR changes. A resolution media query matches only the CURRENT dpr,
    // so it must be recreated after each change to catch the next one.
    let mq = null;
    const onChange = () => { arm(); recompute(); };
    const arm = () => {
      if (mq) mq.removeEventListener('change', onChange);
      mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
      mq.addEventListener('change', onChange);
    };

    // Coalesce bursts of resize events (widget re-layout) into a single recompute.
    let pending = false;
    window.addEventListener('resize', () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; arm(); recompute(); });
    });

    arm();
    recompute();
    document.addEventListener('DOMContentLoaded', recompute);
  } catch (e) { /* never break boot over a cosmetic tweak */ }
})();
