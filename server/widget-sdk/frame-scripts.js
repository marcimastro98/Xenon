'use strict';
// The two scripts Xenon puts into every widget's page under reserved names: the performance
// probe and the guard that turns WebRTC off.

// ── Host performance probe (reserved same-origin asset) ─────────────────────
// The sandbox CSP is `script-src 'self'` (no inline), so the probe ships as a
// separate script the server injects a <script src> tag for into every served
// widget HTML. The RELATIVE src resolves inside /sdk/widget/<id>/, where the
// route serves PERF_PROBE_SOURCE from memory — the name is reserved end to end
// (resolveAsset refuses it, validateWidgetPayload drops it) so a package can
// never smuggle its own file under it. Diagnostics, not security: the probe
// runs in the widget's context and a hostile widget can tamper with it — the
// security boundary remains the CSP sandbox.
const PERF_PROBE_FILENAME = '__xenon-perf.js';

// ── WebRTC off (reserved same-origin asset) ─────────────────────────────────
// `connect-src 'none'` does not cover WebRTC, and no directive does: a STUN or
// TURN address in RTCPeerConnection leaves the machine, and `webrtc 'block'` is
// ignored by Chromium and Edge (measured 5 Nov 2026, as was
// --force-webrtc-ip-handling-policy, which Edge ignores and which leaves TURN
// over TCP open). So the constructors are taken away before any widget code
// runs. This one IS security, unlike the probe: it has to be the first thing in
// the document, blocking, with an absolute src so a page in a subfolder gets it.
// Nothing can bring the constructors back: a widget cannot reach another realm,
// because frame-src 'none' refuses it a child frame.
const FRAME_GUARD_FILENAME = '__xenon-guard.js';
const FRAME_GUARD_SOURCE = "Object.getOwnPropertyNames(window).forEach(function(n){if(/^(webkit)?RTC/.test(n)){try{delete window[n];}catch(e){}}});";

function isReservedAsset(name) {
  return name === PERF_PROBE_FILENAME || name === FRAME_GUARD_FILENAME;
}

// Where a tag can go ahead of everything a page says: past a BOM, comments and
// the doctype, which must stay first or the page falls into quirks mode. A comment
// ends where the HTML parser ends it (`<!-->`, `<!--->` and `--!>` close one too):
// reading it as longer would skip a live script. Stopping early only costs quirks mode.
const DOCUMENT_PREAMBLE_RE = /^\uFEFF?(?:[\t\n\f\r ]|<!--(?:-?>|[\s\S]*?--!?>))*(?:<!doctype[^>]*>)?/i;

function injectFrameGuard(html, assetRoot) {
  const src = String(html == null ? '' : html);
  if (!assetRoot) return src;   // no folder means script-src 'none': nothing runs at all
  const at = DOCUMENT_PREAMBLE_RE.exec(src)[0].length;
  return `${src.slice(0, at)}<script src="${assetRoot}${FRAME_GUARD_FILENAME}"></script>${src.slice(at)}`;
}

// The two host scripts every served widget page carries.
function prepareWidgetHtml(html, assetRoot) {
  return injectFrameGuard(injectPerfProbe(html), assetRoot);
}

// Never touches the widget's DOM, one namespaced global, every path try/caught:
// the probe must never break or observably change a widget. It stays silent
// while the frame is idle/throttled (all-zero window → no message).
//
// It also names what the CSP REFUSED (a CDN script, inline code, a direct
// fetch, a remote image), so a widget's author learns why the tile is blank
// (js/sdk-diagnostics.js validates the report). Each distinct refusal is sent
// once, as a CSP directive plus a bare hostname: never a path or query, which
// can carry a key. The ReportingObserver is buffered, so refusals made while
// the page parsed (before this deferred script ran) still count; the event
// listener covers engines without it, and the shared key dedupes the two.
// localStorage is NOT caught here and cannot be: to the opaque sandboxed
// document every package script is cross-origin, so its errors arrive muted
// ("Script error.", no error object; measured in Chromium). The static scan
// (GET /sdk/check/<id>) is what names it.
const PERF_PROBE_SOURCE = [
  '(() => {',
  "  'use strict';",
  '  try {',
  '    if (window.__xenonPerf) return;',
  '    const S = window.__xenonPerf = { lt: 0, ltN: 0, cls: 0, frames: 0, t0: performance.now() };',
  '    const seen = new Set();',
  '    let held = [];',
  '    let flushT = 0;',
  '    const flush = () => {',
  '      flushT = 0;',
  '      try {',
  '        const items = held.slice(0, 8);',
  '        held = [];',
  "        if (items.length) parent.postMessage({ xenonSdk: 1, type: 'blocked', items }, '*');",
  '      } catch (e) { /* never disturb the widget */ }',
  '    };',
  '    const note = (directive, uri) => {',
  '      try {',
  "        const u = String(uri || '');",
  "        let b = '';",
  "        if (u === 'inline' || u === 'eval' || u === 'wasm-eval') b = u;",
  "        else if (u) { try { b = new URL(u).hostname; } catch (e) { b = ''; } }",
  "        const d = String(directive || '').slice(0, 24);",
  "        const k = d + '|' + b;",
  '        if (!d || seen.has(k) || seen.size >= 32) return;',
  '        seen.add(k);',
  '        held.push({ directive: d, blocked: b });',
  '        if (!flushT) flushT = setTimeout(flush, 1500);',
  '      } catch (e) { /* never disturb the widget */ }',
  '    };',
  '    try {',
  '      new ReportingObserver((rs) => { for (const r of rs) note(r.body.effectiveDirective, r.body.blockedURL); },',
  "        { types: ['csp-violation'], buffered: true }).observe();",
  '    } catch (e) { /* ReportingObserver unsupported */ }',
  "    document.addEventListener('securitypolicyviolation', (e) => note(e.effectiveDirective, e.blockedURI), true);",
  "    // What went wrong while it ran, for the author: an uncaught error, a",
  "    // rejected promise nobody handled, a console.error. Same batching as above.",
  "    const errs = new Map();",
  "    let errT = 0;",
  "    const flushErr = () => {",
  "      errT = 0;",
  "      try {",
  "        const items = [...errs.values()].slice(0, 8);",
  "        errs.clear();",
  "        if (items.length) parent.postMessage({ xenonSdk: 1, type: 'error', items }, '*');",
  "      } catch (e) { /* never disturb the widget */ }",
  "    };",
  "    const fault = (kind, msg) => {",
  "      try {",
  "        const m = String(msg == null ? '' : msg).slice(0, 300);",
  "        const k = kind + '|' + m;",
  "        const prev = errs.get(k);",
  "        if (prev) prev.count++;",
  "        else if (errs.size < 8) errs.set(k, { kind, message: m, count: 1 });",
  "        if (!errT) errT = setTimeout(flushErr, 1500);",
  "      } catch (e) { /* never disturb the widget */ }",
  "    };",
  "    window.addEventListener('error', (e) => { if (e && e.target && e.target !== window) return; fault('error', e && e.message); });",
  "    window.addEventListener('unhandledrejection', (e) => { const r = e && e.reason; fault('rejection', r && r.message ? r.message : r); });",
  "    try {",
  "      const ce = console.error;",
  "      console.error = function (...args) {",
  "        fault('console', args.map((x) => (x && x.message) || String(x)).join(' '));",
  "        return ce.apply(this, args);",
  "      };",
  "    } catch (e) { /* console not writable */ }",
  "    // A page that settles on dark paints an opaque canvas unless its frame element",
  "    // is dark too, so the host hears which it is: a transparent widget stays",
  "    // transparent over the tile, the desktop or a game. 'light dark' follows the",
  "    // element by itself. xenon-client sets the scheme after load, hence the watch.",
  "    let saidDark = false;",
  "    const sayScheme = () => {",
  "      try {",
  "        const css = getComputedStyle(document.documentElement).colorScheme || '';",
  "        const meta = document.querySelector('meta[name=color-scheme]');",
  "        const words = (css && css !== 'normal' ? css : (meta && meta.content) || '').toLowerCase().split(' ');",
  "        const dark = words.includes('dark') && !words.includes('light');",
  "        if (dark === saidDark) return;",
  "        saidDark = dark;",
  "        parent.postMessage({ xenonSdk: 1, type: 'scheme', dark }, '*');",
  "      } catch (e) { /* never disturb the widget */ }",
  "    };",
  "    sayScheme();",
  "    window.addEventListener('load', sayScheme);",
  "    try {",
  "      new MutationObserver(sayScheme).observe(document.documentElement, { attributes: true });",
  "    } catch (e) { /* observer unsupported */ }",
  '    try {',
  "      // A frame in the dashboard's process is also told about the dashboard's own",
  "      // long tasks (named '...-ancestor'). Only 'self' is this widget's work.",
  "      new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.name !== 'self') continue; S.lt += e.duration; S.ltN++; } })",
  "        .observe({ type: 'longtask', buffered: true });",
  '    } catch (e) { /* observer type unsupported */ }',
  '    try {',
  '      new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) S.cls++; } })',
  "        .observe({ type: 'layout-shift', buffered: true });",
  '    } catch (e) { /* observer type unsupported */ }',
  '    const tick = () => { S.frames++; try { requestAnimationFrame(tick); } catch (e) { /* stop */ } };',
  '    try { requestAnimationFrame(tick); } catch (e) { /* no rAF */ }',
  '    setInterval(() => {',
  '      try {',
  '        const now = performance.now();',
  '        const win = now - S.t0;',
  '        const r = {',
  '          xenonSdk: 1, type: \'perf\', windowMs: Math.round(win),',
  '          longTaskMs: Math.round(S.lt), longTasks: S.ltN,',
  '          fps: win > 0 ? Math.round((S.frames * 1000) / win) : 0,',
  '          layoutShifts: S.cls,',
  '        };',
  '        S.lt = 0; S.ltN = 0; S.cls = 0; S.frames = 0; S.t0 = now;',
  '        if (!r.longTasks && !r.layoutShifts && !r.fps) return;',
  "        parent.postMessage(r, '*');",
  '      } catch (e) { /* never disturb the widget */ }',
  '    }, 12000);',
  '  } catch (e) { /* never disturb the widget */ }',
  '})();',
].join('\n');

// Insert the probe <script> tag into a served widget HTML document. Early in
// <head> with `defer`: registered before any widget script runs (defer executes
// in document order, this tag first) while never blocking parsing; observers
// use buffered:true so even pre-registration entries are captured. Pure string
// transform, unit-tested.
function injectPerfProbe(html) {
  const tag = `<script src="${PERF_PROBE_FILENAME}" defer></script>`;
  const src = String(html == null ? '' : html);
  const head = src.match(/<head\b[^>]*>/i);
  if (head) return src.slice(0, head.index + head[0].length) + tag + src.slice(head.index + head[0].length);
  const body = src.search(/<\/body\s*>/i);
  if (body >= 0) return src.slice(0, body) + tag + src.slice(body);
  return src + tag;
}

module.exports = {
  PERF_PROBE_FILENAME, FRAME_GUARD_FILENAME, FRAME_GUARD_SOURCE, isReservedAsset,
  DOCUMENT_PREAMBLE_RE, injectFrameGuard, prepareWidgetHtml, PERF_PROBE_SOURCE, injectPerfProbe,
};
