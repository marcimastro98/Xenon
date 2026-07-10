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
  // direct apply() call can't mount an unbounded document. Roomy enough for a
  // fully hand-drawn procedural scene; the heavy raster detail is meant to ride
  // as bundled image assets, not as more source.
  const CODE_MAX = 60000;

  // ── Bundled image assets ────────────────────────────────────────────────────
  // A background may carry its own images (pixel-art, sprites, textures) as
  // data: URIs — the ONLY way pictures reach the frame, since the CSP allows
  // `img-src data: blob:` and nothing remote. Assets travel INSIDE the artifact
  // (settings / shared code), so a shared background stays self-contained
  // forever: no external hosts, no dead links, no tracking. These caps mirror
  // the settings normalizer (second guard, same reason as CODE_MAX).
  const ASSET_KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;
  const ASSET_DATA_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
  const ASSET_MAX_COUNT = 6;
  const ASSET_MAX_CHARS = 400000;      // per asset (~300 KB image)
  const ASSETS_TOTAL_MAX = 900000;     // whole set (~660 KB of images)

  // Rebuild {name → data URI} keeping only well-formed entries within the caps.
  // Explicit known-shape rebuild (never a spread of untrusted input). This is the
  // SINGLE owner of the asset rules: the client settings normalizer and the
  // server's normalizeBgCustom both call it (window global / require), so the
  // caps and the MIME allowlist can never drift apart.
  //
  // Objects this function produced are remembered (WeakSet) and returned as-is:
  // normalizeSettings re-normalizes the same assets object on every settings
  // mutation, and re-running the regex over ~900 KB of base64 each time would be
  // pure waste. Callers never mutate a normalized map in place (copy-on-write
  // everywhere), so the memo is safe.
  const CLEAN_ASSETS = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  function sanitizeBgAssets(value) {
    if (CLEAN_ASSETS && value && CLEAN_ASSETS.has(value)) return value;
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    let count = 0, total = 0;
    for (const key of Object.keys(value)) {
      if (count >= ASSET_MAX_COUNT) break;
      if (!ASSET_KEY_RE.test(key)) continue;
      const uri = value[key];
      if (typeof uri !== 'string' || uri.length > ASSET_MAX_CHARS) continue;
      if (!ASSET_DATA_RE.test(uri)) continue;
      if (total + uri.length > ASSETS_TOTAL_MAX) continue;
      out[key] = uri;
      count++; total += uri.length;
    }
    if (CLEAN_ASSETS) CLEAN_ASSETS.add(out);
    return out;
  }

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
  // Assets ride the same way: a JSON payload of validated data: URIs, embedded
  // as a JS string literal (identical escaping → no </script> breakout, exact
  // round-trip) and parsed back inside the frame.
  function buildSrcdoc(code, assets) {
    const js = encodeForJsString(String(code || '').slice(0, CODE_MAX));
    const assetsJson = encodeForJsString(JSON.stringify(sanitizeBgAssets(assets)));
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' + FRAME_CSP + '">' +
      '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}' +
      'canvas{display:block;width:100vw;height:100vh}</style></head><body>' +
      '<canvas id="c"></canvas>' +
      '<script>var __src=' + js + ',__assetsJson=' + assetsJson + ';' + BOOTSTRAP + '</scr' + 'ipt>' +
      '</body></html>';
  }

  // Runs inside the frame. Sets up a DPR-aware canvas, decodes the bundled image
  // assets (data: URIs → loaded Image objects) and only THEN compiles the user
  // snippet (contract: define `function draw(ctx, t, w, h, assets)`; assets is a
  // {name → Image} map, also handed to the setup scope) and drives a
  // self-pausing rAF loop. Every user call is wrapped so one thrown error stops
  // the loop cleanly rather than spamming. Reads the snippet/assets from the
  // string literals the host embedded above.
  const BOOTSTRAP = [
    '(function(){',
    'var canvas=document.getElementById("c"),ctx=canvas.getContext("2d");',
    // Tell the host whether the snippet compiled and runs. `null` = running clean;
    // an object {k,m} carries the failure kind + message so the editor can show a
    // real error instead of a silently-black backdrop.
    'function report(err){try{parent.postMessage({__xbgError:(err==null?null:err)},"*");}catch(e){}}',
    'function size(){var d=Math.min(window.devicePixelRatio||1,2);',
    'canvas.width=Math.max(1,Math.floor(innerWidth*d));canvas.height=Math.max(1,Math.floor(innerHeight*d));',
    'ctx.setTransform(d,0,0,d,0,0);}',
    'size();addEventListener("resize",size);',
    'var draw=null,assets={};',
    'var raf=0,start=null;',
    'function frame(t){if(start===null)start=t;var el=(t-start)/1000;',
    'try{if(draw)draw(ctx,el,innerWidth,innerHeight,assets);}catch(e){report({k:"runtime",m:String(e&&e.message||e)});raf=0;return;}',
    'raf=requestAnimationFrame(frame);}',
    'function play(){if(!raf&&draw)raf=requestAnimationFrame(frame);}',
    'function stop(){if(raf){cancelAnimationFrame(raf);raf=0;}}',
    // Pause when the tab is hidden OR the host signals it (perf/game mode).
    'var extPause=false;',
    'function sync(){(document.hidden||extPause)?stop():play();}',
    'document.addEventListener("visibilitychange",sync);',
    'window.addEventListener("message",function(e){var d=e&&e.data;if(d&&d.__xbg){extPause=(d.__xbg==="pause");sync();}});',
    // Compile once every asset is decoded, so the snippet's setup code (and the
    // very first frame) can already drawImage() from the map. A broken data URI
    // is dropped and surfaced as an "asset" status — the rest still render.
    'function boot(){var cErr=null;',
    'try{var factory=new Function("canvas","ctx","assets",__src+"\\n;return (typeof draw===\\"function\\")?draw:null;");',
    'draw=factory(canvas,ctx,assets);}catch(e){draw=null;cErr=String(e&&e.message||e);}',
    'report(draw?null:{k:cErr?"compile":"nodraw",m:cErr||""});',
    'sync();}',
    'var parsed={},names=[];try{parsed=JSON.parse(__assetsJson)||{};names=Object.keys(parsed);}catch(e){parsed={};}',
    'if(!names.length){boot();}else{',
    'var left=names.length,bad=[];',
    // boot() first so a compile error (the bigger problem) wins the status line;
    // an asset failure is only surfaced when the code itself is fine.
    'function done(){if(--left>0)return;boot();if(bad.length&&draw)report({k:"asset",m:bad.join(", ")});}',
    'names.forEach(function(n){var img=new Image();',
    'img.onload=function(){assets[n]=img;done();};',
    'img.onerror=function(){bad.push(n);done();};',
    'img.src=parsed[n];});}',
    '})();',
  ].join('');

  // ── Host mount/unmount (browser only) ──────────────────────────────────────
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    let current = null;        // the code string currently mounted (avoid needless remounts)
    let currentAssets = {};    // shallow snapshot of the mounted assets map — a changed image remounts too
    let frameEl = null;        // the live iframe, so the host can signal pause/resume
    let lastPaused = null;

    // Cheap idempotency for the assets map: same keys, identical string values.
    // Values are compared by reference in practice (normalizers copy the SAME
    // string references), so this is O(keys) — never a scan of megabyte URIs.
    function sameAssetMaps(a, b) {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) if (a[k] !== b[k]) return false;
      return true;
    }

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
      currentAssets = {};
      frameEl = null;
    }

    function mount(code, assets) {
      const host = layer();
      const frame = document.createElement('iframe');
      // No allow-same-origin: the frame runs at a null origin, isolated from the
      // dashboard. allow-scripts is the only capability it gets.
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('tabindex', '-1');
      frame.title = '';
      frame.srcdoc = buildSrcdoc(code, assets);   // buildSrcdoc sanitizes (second guard)
      // Once the frame's script is live, tell it the current pause state (it may
      // have been mounted while already in perf/game mode).
      frameEl = frame;
      lastPaused = null;
      frame.addEventListener('load', () => syncPause(true));
      host.replaceChildren(frame);
      current = code;
      currentAssets = Object.assign({}, (assets && typeof assets === 'object') ? assets : {});
    }

    // Mount `code` (+ optional bundled image assets) as the animated background,
    // or clear it when falsy. Idempotent on the same code+assets so re-applying
    // settings — which happens on EVERY settings mutation — neither restarts the
    // animation nor pays any per-call work proportional to the asset bytes.
    function apply(code, assets) {
      const next = (typeof code === 'string' && code.trim()) ? code.slice(0, CODE_MAX) : '';
      if (!next) { if (current !== null) unmount(); document.body.classList.remove('custom-bg-on'); return; }
      const rawAssets = (assets && typeof assets === 'object' && !Array.isArray(assets)) ? assets : {};
      if (next === current && sameAssetMaps(rawAssets, currentAssets)) { document.body.classList.add('custom-bg-on'); return; }
      mount(next, rawAssets);
      document.body.classList.add('custom-bg-on');
    }

    // Watch body-class changes (perf-mode / game-mode toggle) and relay the
    // pause state to the live frame. Cheap: syncPause no-ops unless it changed.
    try {
      new MutationObserver(() => syncPause()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch { /* no MutationObserver → backdrop just won't auto-pause */ }

    // The frame reports the snippet's status (null = clean, or {k,m} on failure).
    // Relay it to the app as a DOM event so the settings editor can surface a
    // friendly error. Source-checked against the live frame so nothing else can
    // spoof a status; the payload is only ever rendered as textContent host-side.
    window.addEventListener('message', (e) => {
      if (!frameEl || e.source !== frameEl.contentWindow) return;
      const d = e && e.data;
      if (!d || typeof d !== 'object' || !('__xbgError' in d)) return;
      const err = d.__xbgError;
      try {
        document.dispatchEvent(new CustomEvent('xenon-bg-status', {
          detail: {
            ok: err == null,
            kind: (err && typeof err.k === 'string') ? err.k : '',
            message: (err && typeof err.m === 'string') ? err.m.slice(0, 300) : '',
          },
        }));
      } catch { /* CustomEvent unsupported → no editor feedback, backdrop still works */ }
    });

    window.CustomBg = {
      apply, buildSrcdoc, sanitizeBgAssets,
      // Caps + shape rules exported so the settings UI pre-checks (friendly
      // toasts) read the SAME numbers the sanitizer enforces.
      ASSET_DATA_RE, ASSET_MAX_COUNT, ASSET_MAX_CHARS, ASSETS_TOTAL_MAX,
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildSrcdoc, encodeForJsString, sanitizeBgAssets,
      CODE_MAX, ASSET_MAX_COUNT, ASSET_MAX_CHARS, ASSETS_TOTAL_MAX,
    };
  }
})();
