'use strict';

// ── SDK widget sandbox diagnostics (pure logic) ─────────────────────────────
// A widget written as a normal web page (CDN scripts, inline code, onclick=,
// fetch(), localStorage) fails silently inside the sandbox: the tile stays
// blank and nothing says why. This module names those things for the widget's
// AUTHOR, from two sources that share one vocabulary of issue kinds:
//   - scanWidgetSource: a static read of the package's own HTML/JS/CSS
//     (server.js GET /sdk/check/<id>), so every problem shows at once, even
//     the ones behind a script that never loaded;
//   - validateBlockedReport: what the host-injected probe saw the CSP refuse at
//     run time (sdk-widgets.js PERF_PROBE_SOURCE → {type:'blocked'}), which
//     also catches URLs the code builds at run time.
//
// Diagnostics, not security: the sandbox and CSP stay exactly as they are and
// nothing here grants anything. A forged report can only claim a bounded list
// of known kinds and a hostname. The scan is a heuristic that can miss things
// or flag a comment-free string, which is fine for a hint and why it never
// blocks an install. UMD like sdk-perf.js so it runs on the server (the scan)
// and in the dashboard (report validation) and is unit-tested under Node
// (test/sdk-diagnostics.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.SdkDiagnostics = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Display order: what stops a widget from running at all comes first.
  const ISSUE_KINDS = Object.freeze([
    'remote_script', 'inline_script', 'inline_handler', 'eval',
    'network', 'storage', 'remote_style', 'remote_asset', 'frame', 'other',
  ]);
  const ISSUES_MAX = 20;
  const REPORT_ITEMS_MAX = 8;

  const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i;
  const DIRECTIVE_RE = /^[a-z-]{3,24}$/;
  const REMOTE_URL_RE = /^\s*(?:https?:)?\/\//i;
  const FILE_RE = /^[A-Za-z0-9._/-]{1,200}$/;

  function hostOf(url) {
    try {
      const h = new URL(String(url).trim(), 'https://package.invalid/').hostname.toLowerCase();
      return HOST_RE.test(h) && h !== 'package.invalid' ? h : '';
    } catch { return ''; }
  }

  function issue(kind, file, host) {
    const out = { kind };
    if (file && FILE_RE.test(file)) out.file = file;
    if (host && HOST_RE.test(host)) out.host = host.toLowerCase();
    return out;
  }

  const issueKey = (i) => i.kind + '|' + (i.file || '') + '|' + (i.host || '');

  // Dedupe + cap, keeping first-seen order. Returns a NEW array.
  function mergeIssues(list, incoming, max) {
    const cap = Number.isInteger(max) && max > 0 ? max : ISSUES_MAX;
    const out = Array.isArray(list) ? list.slice(0, cap) : [];
    const seen = new Set(out.map(issueKey));
    for (const i of Array.isArray(incoming) ? incoming : []) {
      if (out.length >= cap) break;
      if (!i || !ISSUE_KINDS.includes(i.kind)) continue;
      const k = issueKey(i);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(i);
    }
    return out;
  }

  // ── Static scan ────────────────────────────────────────────────────────────

  // Comments mention `fetch(` and `localStorage` all the time (ours do). The
  // `//` strip skips `://` so URLs in strings survive.
  function stripJsComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  }

  function attrs(tagSrc) {
    const out = {};
    const re = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
    let m;
    while ((m = re.exec(tagSrc))) out[m[1].toLowerCase()] = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
    return out;
  }

  // A <script type> the browser does not execute (JSON data, templates) is not
  // blocked by script-src, so it is not an issue.
  function executableScriptType(type) {
    const t = String(type || '').trim().toLowerCase();
    return !t || t === 'module' || /^(text|application)\/(x-)?(java|ecma)script$/.test(t);
  }

  function scanJs(src, file, out) {
    const js = stripJsComments(src);
    if (/(^|[^.\w$])fetch\s*\(|\b(?:window|self|globalThis)\.fetch\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\b|\bnavigator\.sendBeacon\b/.test(js)) {
      out.push(issue('network', file));
    }
    if (/\b(?:localStorage|sessionStorage|indexedDB)\b|\bdocument\.cookie\b/.test(js)) out.push(issue('storage', file));
    if (/(^|[^.\w$])eval\s*\(|\bnew\s+Function\s*\(/.test(js)) out.push(issue('eval', file));
  }

  function scanCss(src, file, out) {
    const css = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const imp = /@import\s+(?:url\(\s*)?["']?((?:https?:)?\/\/[^"')\s;]+)/gi;
    let m;
    while ((m = imp.exec(css))) out.push(issue('remote_style', file, hostOf(m[1])));
    const url = /url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi;
    while ((m = url.exec(css))) {
      // An @import url(...) was already counted as a stylesheet above.
      if (/@import\s+$/i.test(css.slice(Math.max(0, m.index - 12), m.index))) continue;
      out.push(issue('remote_asset', file, hostOf(m[1])));
    }
  }

  function scanHtml(src, file, out) {
    const html = src.replace(/<!--[\s\S]*?-->/g, ' ');
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = scriptRe.exec(html))) {
      const a = attrs(m[1]);
      if (!executableScriptType(a.type)) continue;
      if (a.src != null) {
        if (REMOTE_URL_RE.test(a.src)) out.push(issue('remote_script', file, hostOf(a.src)));
      } else if (m[2].trim()) {
        out.push(issue('inline_script', file));
        scanJs(m[2], file, out);
      }
    }
    // Everything below must not read script bodies as markup.
    const markup = html.replace(scriptRe, ' ');
    const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
    while ((m = styleRe.exec(markup))) scanCss(m[1], file, out);
    if (/<[a-z][^>]*?\son[a-z]+\s*=/i.test(markup) || /\shref\s*=\s*["']?\s*javascript:/i.test(markup)) {
      out.push(issue('inline_handler', file));
    }
    const tagRe = /<(link|img|source|video|audio|iframe|embed|object)\b([^>]*)>/gi;
    while ((m = tagRe.exec(markup))) {
      const tag = m[1].toLowerCase();
      const a = attrs(m[2]);
      if (tag === 'iframe' || tag === 'embed' || tag === 'object') { out.push(issue('frame', file)); continue; }
      if (tag === 'link') {
        if (/\bstylesheet\b/i.test(a.rel || '') && REMOTE_URL_RE.test(a.href || '')) out.push(issue('remote_style', file, hostOf(a.href)));
        continue;
      }
      if (REMOTE_URL_RE.test(a.src || '')) out.push(issue('remote_asset', file, hostOf(a.src)));
    }
  }

  // files: [{ path, text }] — the package's own files. Returns issues
  // [{ kind, file?, host? }], deduped, capped, in ISSUE_KINDS order.
  function scanWidgetSource(files) {
    const found = [];
    for (const f of Array.isArray(files) ? files : []) {
      if (!f || typeof f.path !== 'string' || typeof f.text !== 'string') continue;
      const ext = (f.path.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
      if (ext === '.html' || ext === '.htm') scanHtml(f.text, f.path, found);
      else if (ext === '.js' || ext === '.mjs') scanJs(f.text, f.path, found);
      else if (ext === '.css') scanCss(f.text, f.path, found);
    }
    const merged = mergeIssues([], found, ISSUES_MAX);
    return merged.sort((a, b) => ISSUE_KINDS.indexOf(a.kind) - ISSUE_KINDS.indexOf(b.kind));
  }

  // ── Run-time reports from the probe ────────────────────────────────────────

  // CSP directive + blocked value → issue kind. (No `storage` here: the probe
  // cannot see it, see PERF_PROBE_SOURCE; only the static scan names it.)
  function kindOfBlocked(directive, blocked) {
    const d = directive.replace(/-(elem|attr)$/, '');
    if (directive === 'script-src-attr') return 'inline_handler';
    if (d === 'script-src') {
      if (blocked === 'eval' || blocked === 'wasm-eval') return 'eval';
      return blocked === 'inline' ? 'inline_script' : 'remote_script';
    }
    if (d === 'style-src') return 'remote_style';
    if (d === 'img-src' || d === 'font-src' || d === 'media-src') return 'remote_asset';
    if (d === 'connect-src') return 'network';
    if (d === 'frame-src' || d === 'child-src' || d === 'object-src') return 'frame';
    return 'other';
  }

  // raw: { items: [{ directive, blocked }] } from the probe. Returns validated
  // issues (possibly empty) or null for a malformed report.
  function validateBlockedReport(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
    if (!raw.items.length || raw.items.length > REPORT_ITEMS_MAX) return null;
    const out = [];
    for (const it of raw.items) {
      if (!it || typeof it !== 'object' || typeof it.directive !== 'string' || typeof it.blocked !== 'string') return null;
      const directive = it.directive.toLowerCase();
      const blocked = it.blocked.toLowerCase();
      if (!DIRECTIVE_RE.test(directive)) return null;
      const special = blocked === '' || blocked === 'inline' || blocked === 'eval' || blocked === 'wasm-eval';
      if (!special && !HOST_RE.test(blocked)) return null;
      out.push(issue(kindOfBlocked(directive, blocked), '', special ? '' : blocked));
    }
    return mergeIssues([], out, REPORT_ITEMS_MAX);
  }

  // What the probe saw go wrong while the widget ran (PERF_PROBE_SOURCE →
  // {type:'error'}): an uncaught error, a rejected promise nobody handled, or a
  // console.error. For the author only (Settings and the xenon-mcp tools), never
  // shown as HTML. A thrown error from a widget script reaches the probe as the
  // browser's muted "Script error." (the sandbox is another origin), so the
  // console and promise kinds are the ones that carry a real message.
  const ERROR_KINDS = Object.freeze(['error', 'rejection', 'console']);
  const ERROR_TEXT_MAX = 300;
  const ERRORS_MAX = 20;
  function cleanErrorText(v) {
    return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, ERROR_TEXT_MAX);
  }
  function validateErrorReport(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
    if (!raw.items.length || raw.items.length > REPORT_ITEMS_MAX) return null;
    const out = [];
    for (const it of raw.items) {
      if (!it || typeof it !== 'object' || !ERROR_KINDS.includes(it.kind)) return null;
      const count = Number.isInteger(it.count) && it.count > 0 ? Math.min(it.count, 9999) : 1;
      out.push({ kind: it.kind, message: cleanErrorText(it.message), count });
    }
    return out;
  }
  // The same error again only counts up; the newest distinct ones are kept.
  function mergeErrors(list, incoming) {
    const out = Array.isArray(list) ? list.map((e) => ({ ...e })) : [];
    for (const e of Array.isArray(incoming) ? incoming : []) {
      const same = out.find((o) => o.kind === e.kind && o.message === e.message);
      if (same) { same.count = Math.min(9999, same.count + e.count); continue; }
      out.push({ ...e });
    }
    return out.slice(-ERRORS_MAX);
  }

  return {
    ISSUE_KINDS,
    ISSUES_MAX,
    REPORT_ITEMS_MAX,
    ERROR_KINDS,
    scanWidgetSource,
    validateBlockedReport,
    validateErrorReport,
    mergeIssues,
    mergeErrors,
  };
});
