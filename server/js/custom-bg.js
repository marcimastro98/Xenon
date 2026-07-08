'use strict';

// ── Code-defined animated background ─────────────────────────────────────────
// A user (or a shared theme/package) can supply a small piece of JavaScript that
// paints an animated backdrop onto a full-viewport <canvas>. That code is
// UNTRUSTED — it is run inside a locked-down sandboxed iframe using the EXACT
// same kill-switch as the SDK widgets (see server/sdk-widgets.js WIDGET_CSP):
//
//   • sandbox="allow-scripts" WITHOUT allow-same-origin → the frame's origin is
//     null, so it cannot read cookies/storage or touch this dashboard's DOM.
//   • Content-Security-Policy `connect-src 'none'` → no fetch/XHR/WebSocket, so
//     the code can compute and draw but can never phone home or exfiltrate.
//   • `img-src data: blob:` only, `default-src 'none'` → no remote asset loads.
//
// The frame sits in the background layer (behind the shell, pointer-events:none),
// self-pauses when the tab is hidden, and swallows its own errors so a broken
// snippet degrades to a blank backdrop instead of taking anything down. The host
// keeps NO reference into the frame beyond replacing/removing it.
(function () {
  'use strict';

  // Same ceiling the settings normalizer enforces — a second guard here so a
  // direct apply() call can't mount an unbounded document.
  const CODE_MAX = 20000;

  // 'unsafe-eval' is required for `new Function(...)` INSIDE the frame; it is
  // safe precisely because the frame is a null-origin sandbox with
  // connect-src 'none' — eval'd code there can compute but reach nothing.
  const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; " +
    "base-uri 'none'; form-action 'none'";

  // Embed the user code as a real JS string literal inside the executed <script>.
  // JSON.stringify makes a valid, quoted literal (handles quotes, backslashes and
  // newlines); then every "<", ">" and the two JS line-terminator code points
  // (U+2028/U+2029) are turned into \uXXXX escapes. That does two jobs at once:
  // the substring "</script>" can never appear in the HTML source (so the snippet
  // can't break out of the script element), and — because these are JS string
  // escapes, not HTML entities — they decode back to the EXACT original
  // characters when the browser parses the string.
  //
  // (A prior version used a <script type="text/plain"> block + textContent, but
  // <script> is an HTML raw-text element that does NOT decode entities, so an
  // escaped "&lt;" came back literally and any snippet using "<" failed to
  // compile — every background rendered blank. Hence this JS-string approach.)
  function encodeForJsString(code) {
    const json = JSON.stringify(String(code == null ? '' : code));
    let out = '';
    for (let i = 0; i < json.length; i++) {
      const cc = json.charCodeAt(i);
      // < > and the JS line/paragraph separators (U+2028/U+2029) → \uXXXX.
      if (cc === 0x3c || cc === 0x3e || cc === 0x2028 || cc === 0x2029) {
        out += '\\u' + ('000' + cc.toString(16)).slice(-4);
      } else {
        out += json[i];
      }
    }
    return out;
  }

  // The self-contained sandbox document. Static bootstrap + the user snippet as a
  // safely-encoded JS string; exported for unit testing the encoding/shape.
  function buildSrcdoc(code) {
    const js = encodeForJsString(String(code || '').slice(0, CODE_MAX));
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' + FRAME_CSP + '">' +
      '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}' +
      'canvas{display:block;width:100vw;height:100vh}</style></head><body>' +
      '<canvas id="c"></canvas>' +
      '<script>var __src=' + js + ';' + BOOTSTRAP + '</scr' + 'ipt>' +
      '</body></html>';
  }

  // Runs inside the frame. Sets up a DPR-aware canvas, compiles the user snippet
  // (contract: define `function draw(ctx, t, w, h)`), and drives a self-pausing
  // rAF loop. Every user call is wrapped so one thrown error stops the loop
  // cleanly rather than spamming. Reads the snippet from the __src string literal
  // the host embedded above.
  const BOOTSTRAP = [
    '(function(){',
    'var canvas=document.getElementById("c"),ctx=canvas.getContext("2d");',
    'function size(){var d=Math.min(window.devicePixelRatio||1,2);',
    'canvas.width=Math.max(1,Math.floor(innerWidth*d));canvas.height=Math.max(1,Math.floor(innerHeight*d));',
    'ctx.setTransform(d,0,0,d,0,0);}',
    'size();addEventListener("resize",size);',
    'var draw=null;',
    'try{var factory=new Function("canvas","ctx",__src+"\\n;return (typeof draw===\\"function\\")?draw:null;");',
    'draw=factory(canvas,ctx);}catch(e){draw=null;}',
    'var raf=0,start=null;',
    'function frame(t){if(start===null)start=t;var el=(t-start)/1000;',
    'try{if(draw)draw(ctx,el,innerWidth,innerHeight);}catch(e){raf=0;return;}',
    'raf=requestAnimationFrame(frame);}',
    'function play(){if(!raf&&draw)raf=requestAnimationFrame(frame);}',
    'function stop(){if(raf){cancelAnimationFrame(raf);raf=0;}}',
    // Pause when the tab is hidden OR the host signals it (perf/game mode).
    'var extPause=false;',
    'function sync(){(document.hidden||extPause)?stop():play();}',
    'document.addEventListener("visibilitychange",sync);',
    'window.addEventListener("message",function(e){var d=e&&e.data;if(d&&d.__xbg){extPause=(d.__xbg==="pause");sync();}});',
    'sync();',
    '})();',
  ].join('');

  // ── Host mount/unmount (browser only) ──────────────────────────────────────
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    let current = null;   // the code string currently mounted (avoid needless remounts)
    let frameEl = null;   // the live iframe, so the host can signal pause/resume
    let lastPaused = null;

    // Performance / game mode must stop EVERY animated backdrop, custom ones
    // included. The built-in aurora/grid are CSS (paused/hidden via body classes),
    // but this backdrop is an iframe running its own rAF, so hiding it wouldn't
    // stop the work. The host posts a pause/resume the frame acts on — matching
    // aurora/grid: paused under perf-mode (also hidden via CSS) and frozen under
    // game-mode.
    function hostPaused() {
      const c = document.body.classList;
      return c.contains('perf-mode') || c.contains('game-mode');
    }
    function syncPause(force) {
      if (!frameEl || !frameEl.contentWindow) return;
      const paused = hostPaused();
      if (!force && paused === lastPaused) return;
      lastPaused = paused;
      try { frameEl.contentWindow.postMessage({ __xbg: paused ? 'pause' : 'play' }, '*'); } catch { /* frame gone */ }
    }

    function layer() {
      let el = document.getElementById('custom-bg-layer');
      if (!el) {
        el = document.createElement('div');
        el.id = 'custom-bg-layer';
        el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(el);
      }
      return el;
    }

    function unmount() {
      const el = document.getElementById('custom-bg-layer');
      if (el) el.replaceChildren();
      current = null;
      frameEl = null;
    }

    function mount(code) {
      const host = layer();
      const frame = document.createElement('iframe');
      // No allow-same-origin: the frame runs at a null origin, isolated from the
      // dashboard. allow-scripts is the only capability it gets.
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('tabindex', '-1');
      frame.title = '';
      frame.srcdoc = buildSrcdoc(code);
      // Once the frame's script is live, tell it the current pause state (it may
      // have been mounted while already in perf/game mode).
      frameEl = frame;
      lastPaused = null;
      frame.addEventListener('load', () => syncPause(true));
      host.replaceChildren(frame);
      current = code;
    }

    // Mount `code` as the animated background, or clear it when falsy. Idempotent
    // on the same code so re-applying settings doesn't restart the animation.
    function apply(code) {
      const next = (typeof code === 'string' && code.trim()) ? code.slice(0, CODE_MAX) : '';
      if (!next) { if (current !== null) unmount(); document.body.classList.remove('custom-bg-on'); return; }
      if (next === current) { document.body.classList.add('custom-bg-on'); return; }
      mount(next);
      document.body.classList.add('custom-bg-on');
    }

    // Watch body-class changes (perf-mode / game-mode toggle) and relay the
    // pause state to the live frame. Cheap: syncPause no-ops unless it changed.
    try {
      new MutationObserver(() => syncPause()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch { /* no MutationObserver → backdrop just won't auto-pause */ }

    window.CustomBg = { apply, buildSrcdoc };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildSrcdoc, encodeForJsString, CODE_MAX };
  }
})();
