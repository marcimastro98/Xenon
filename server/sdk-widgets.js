'use strict';
// Third-party widget SDK — server-side package validation and asset resolution.
//
// A "widget package" is a folder under DATA_DIR/widgets/<id>/ containing a
// manifest.json plus the HTML/JS/CSS assets of a sandboxed dashboard widget.
// This module is the SECURITY BOUNDARY for everything that comes out of those
// folders: the manifest is rebuilt key-by-key (never spread), asset paths are
// resolved against a strict allowlist, and every served asset carries a CSP
// that (a) re-sandboxes the document even when opened directly as a top-level
// page and (b) blocks ALL network access from widget code. The latter is
// load-bearing: a sandboxed iframe has an opaque origin, so its fetches would
// arrive at the local API with `Origin: null` — which isAllowedRequest()
// deliberately accepts for the iCUE WebView. Without `connect-src 'none'` a
// hostile widget could call the local API directly. All host interaction goes
// through the postMessage bridge in js/custom-widget.js instead, where grants
// are enforced.
//
// Pure and requireable (no server state) so the hostile-input paths are unit
// tested in server/test/sdk-widgets.test.mjs.

const fs = require('fs');
const path = require('path');
const { validateAction, clampDelay } = require('./js/deck-actions.js');

// Version of the host↔widget postMessage protocol (see docs/WIDGET_SDK.md).
const SDK_API_VERSION = 1;

// Data streams a package may request; each maps 1:1 to an SSE event the
// dashboard already receives. The host only forwards streams the user granted.
const SDK_STREAMS = Object.freeze(['status', 'system', 'media', 'audio', 'wavelink', 'stocks', 'football', 'news', 'claude', 'obs', 'discord', 'streamerbot', 'homeassistant', 'tasks', 'notes', 'agenda', 'weather']);

// Action categories a package may request → the deck-action types each grants.
// Deliberately a small, low-blast-radius subset of the action registry; every
// dispatched action is still fully re-validated by server/actions/registry.js.
const SDK_ACTION_CATEGORIES = Object.freeze({
  media: Object.freeze(['media']),
  volume: Object.freeze(['volume', 'appVolume', 'appMute']),
  mic: Object.freeze(['micMute']),
  lighting: Object.freeze(['lighting', 'lightPower', 'lightColor', 'lightAuto', 'lightEffect', 'lightDevice']),
  chroma: Object.freeze(['chromaColor', 'chromaOff']),
  wavelink: Object.freeze(['wlInputVolume', 'wlInputMute', 'wlOutputVolume', 'wlOutputMute', 'wlSwitchMonitoring', 'wlSetMonitorMix']),
  // Service-control categories (grant-gated). Each action type is already
  // validated by the registry against the connected service; a widget can only
  // reach the service the user connected AND granted. `haCallService` is
  // deliberately left OUT — an arbitrary HA service call is too broad to hand to
  // untrusted widget code; the typed device actions cover normal control.
  spotify: Object.freeze(['spotifyPlay', 'spotifyNext', 'spotifyPrev', 'spotifySave', 'spotifyLike', 'spotifyShuffle', 'spotifyRepeat', 'spotifyVolume', 'spotifySeek', 'spotifyPlaylist', 'spotifyDevice']),
  obs: Object.freeze(['obsScene', 'obsSceneNext', 'obsRecord', 'obsStream', 'obsMute', 'obsInputVolume']),
  discord: Object.freeze(['discordMute', 'discordDeafen', 'discordPtt', 'discordJoin', 'discordLeave', 'discordInputVol', 'discordOutputVol', 'discordAudioToggle', 'discordSoundboard']),
  homeassistant: Object.freeze(['haToggle', 'haLight', 'haMedia', 'haCover', 'haClimate', 'haFan', 'haVacuum', 'haLock', 'haAlarm', 'haScene', 'haScript', 'haButton']),
  twitch: Object.freeze(['twitchClip', 'twitchMarker', 'twitchAd', 'twitchTitle', 'twitchGame', 'twitchChat', 'twitchShoutout', 'twitchChatMode']),
  youtube: Object.freeze(['ytBroadcast']),
  streamerbot: Object.freeze(['sbDoAction', 'sbSendMessage', 'sbCodeTrigger']),
  url: Object.freeze(['openUrl']),
  // Personal to-do list: add / toggle / delete a task in the same list the Tasks
  // tile shows. Low-risk (your own notes-style data, no system reach), grant-gated,
  // and each mutation is validated + length-capped in the action registry.
  tasks: Object.freeze(['taskAdd', 'taskToggle', 'taskDelete']),
});

// Every deck-action type the SDK can reach, across all categories. Macro steps
// are restricted to this set — openApp/openFile/hotkey/webhook stay unreachable.
const SDK_ACTION_TYPES = Object.freeze(Object.values(SDK_ACTION_CATEGORIES).flat());

// Category (grant unit) a deck-action type belongs to, or null. Used to check a
// macro's steps against the categories the user granted the package.
function categoryOfActionType(type) {
  for (const [cat, types] of Object.entries(SDK_ACTION_CATEGORIES)) {
    if (types.includes(type)) return cat;
  }
  return null;
}

// Package ids are folder names: short, lowercase, no dots/slashes → they can
// never traverse and are safe inside a URL path segment.
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

// Ids for hooks, deck macros and deck states share the package-id charset, so a
// composite ref like "pkg/macro" splits unambiguously on the first '/'.
const SDK_SUB_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// Entry document and asset filenames (per path segment): conservative charset,
// must carry an allowlisted extension, and '..' is impossible by construction.
const ENTRY_RE = /^[A-Za-z0-9._-]+\.html?$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

const ASSET_MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
});

// The CSP served with EVERY widget asset. `sandbox allow-scripts` keeps the
// document sandboxed (opaque origin, no allow-same-origin) even when navigated
// to directly; `connect-src 'none'` closes the Origin:null hole described in
// the header comment. Do not weaken either directive — a widget that "needs"
// network access is a protocol design change, not a CSP relaxation.
const WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  'sandbox allow-scripts',
].join('; ');

const MANIFEST_MAX_BYTES = 32 * 1024;
const MAX_PACKAGES = 32;

// Caps for the manifest extensions (all additive to api 1).
const MAX_HOSTS = 8;
const MAX_HOOKS = 8;
const MAX_MACROS = 8;
const MAX_MACRO_STEPS = 10;
const MAX_STATES = 8;
// Handler actions (deck keys answered by the widget's own code) and their
// declared per-key params. Small on purpose: a handler is a named entry point,
// not a scripting surface.
const MAX_HANDLERS = 8;
const MAX_HANDLER_PARAMS = 4;
const HANDLER_PARAM_KINDS = Object.freeze(['text', 'select', 'number']);
const HANDLER_ARG_TEXT_MAX = 200;
// Per-step delay cap for SDK macros. Lower than the native Deck step cap
// (clampDelay's 10s) ON PURPOSE: an SDK macro runs server-side inside one
// /actions/run request, so its total wait must stay bounded. The registry
// enforces the SAME number at run time — keep the two in lockstep.
const MAX_MACRO_STEP_DELAY_MS = 5000;

// Proxy request limits (enforced again by the /sdk/fetch handler).
const PROXY_BODY_MAX_BYTES = 256 * 1024;
const PROXY_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
// Request headers a widget may set through the proxy: the usual API-auth and
// content-negotiation names plus custom x-* — never cookie/host/origin.
const PROXY_HEADER_NAMES = Object.freeze(['accept', 'accept-language', 'content-type', 'authorization']);
const PROXY_CUSTOM_HEADER_RE = /^x-[a-z0-9-]{1,40}$/;
const PROXY_MAX_HEADERS = 12;

// RFC 1123 hostname (also matches IPv4 literals). IPv6 literals are rejected —
// the private/loopback classification below is IPv4+names only, on purpose.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;

// Hosts a manifest may never declare and the proxy may never contact: the local
// API itself and everything loopback/link-local lives here. This is the wire-
// level half of the sandbox kill-switch — the widget CSP blocks direct network,
// and this keeps the proxy from being a detour back to 127.0.0.1:3030.
function isForbiddenProxyHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

// Private-network targets (LAN gear rarely has TLS) — the only hosts plain
// http:// is allowed to. RFC1918 IPv4 literals, .local mDNS names, and
// single-label hostnames (NAS, printers); everything public must use https.
function isPrivateNetworkHost(host) {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.endsWith('.local')) return true;
  return !host.includes('.');
}

// Lowercased, validated hostname for the manifest allowlist — or '' if it isn't
// an acceptable proxy target (bad charset, IPv6, loopback/link-local).
function normalizeProxyHost(value) {
  const host = String(value == null ? '' : value).trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) return '';
  if (isForbiddenProxyHost(host)) return '';
  return host;
}

function cleanStr(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanList(value, allowed, max) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!allowed.includes(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

// hosts: exact hostnames the package may reach through the fetch proxy. A
// forbidden/invalid entry rejects the whole manifest (loud beats a silently
// narrower allowlist the author never notices).
function normalizeHosts(raw) {
  if (raw == null) return { ok: true, hosts: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const out = [];
  for (const item of raw) {
    const host = typeof item === 'string' ? normalizeProxyHost(item) : '';
    if (!host) return { ok: false };
    if (!out.includes(host)) out.push(host);
    if (out.length > MAX_HOSTS) return { ok: false };
  }
  return { ok: true, hosts: out };
}

// hooks: ids the package may receive local webhook events on (POST /sdk/hook/<pkg>/<id>).
function normalizeHooks(raw) {
  if (raw == null) return { ok: true, hooks: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const out = [];
  for (const item of raw) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (!SDK_SUB_ID_RE.test(id)) return { ok: false };
    if (!out.includes(id)) out.push(id);
    if (out.length > MAX_HOOKS) return { ok: false };
  }
  return { ok: true, hooks: out };
}

// One handler's declared params, rebuilt key-by-key. Returns the clean array,
// or null when anything is malformed (reject-loud, like the rest of the deck
// extras). Kinds: text (free string), select (fixed options), number (min/max).
function normalizeHandlerParams(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_HANDLER_PARAMS) return null;
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') return null;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!SDK_SUB_ID_RE.test(name) || out.some(x => x.name === name)) return null;
    const kind = p.kind;
    if (!HANDLER_PARAM_KINDS.includes(kind)) return null;
    const param = { name, label: cleanStr(p.label, 24) || name, kind };
    if (kind === 'select') {
      if (!Array.isArray(p.options) || !p.options.length || p.options.length > 8) return null;
      const options = [];
      for (const o of p.options) {
        const opt = cleanStr(o, 24);
        if (!opt || options.includes(opt)) return null;
        options.push(opt);
      }
      param.options = options;
    } else if (kind === 'number') {
      const min = Number(p.min);
      const max = Number(p.max);
      param.min = Number.isFinite(min) ? min : 0;
      param.max = Number.isFinite(max) ? max : 100;
      if (param.max < param.min) return null;
    }
    out.push(param);
  }
  return out;
}

// deck: { actions:[{id,name,steps}], states:[{id,name}], handlers:[{id,name,params}] }
// — the package's Deck contributions. Macro steps are REBUILT through the shared
// catalog validator (never spread), restricted to the SDK's low-risk action
// types, and their categories must be a subset of the manifest's declared
// `actions` (so the user is actually asked to grant them); anything outside that
// rejects the manifest. States are display metadata only. Handlers are named
// entry points the widget's own code answers when a bound deck key is pressed
// (delivered over the bridge, grant-gated per handler id like hooks).
function normalizeDeckExtras(raw, declaredActions) {
  const empty = { actions: [], states: [], handlers: [] };
  if (raw == null) return { ok: true, deck: empty };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const deck = { actions: [], states: [], handlers: [] };
  if (raw.actions != null) {
    if (!Array.isArray(raw.actions) || raw.actions.length > MAX_MACROS) return { ok: false };
    for (const m of raw.actions) {
      if (!m || typeof m !== 'object') return { ok: false };
      const id = typeof m.id === 'string' ? m.id.trim() : '';
      const name = cleanStr(m.name, 40);
      if (!SDK_SUB_ID_RE.test(id) || !name) return { ok: false };
      if (deck.actions.some(a => a.id === id)) return { ok: false };
      if (!Array.isArray(m.steps) || !m.steps.length || m.steps.length > MAX_MACRO_STEPS) return { ok: false };
      const steps = [];
      for (const s of m.steps) {
        const action = validateAction(s && s.action);
        if (!action || !SDK_ACTION_TYPES.includes(action.type)) return { ok: false };
        // A macro step may only touch categories the manifest also DECLARES in
        // `actions` — otherwise the user is never asked to grant that category
        // and the macro can never run (macro_unavailable). Fail loud at install.
        const cat = categoryOfActionType(action.type);
        if (!cat || !declaredActions.includes(cat)) return { ok: false };
        steps.push({ action, delayMs: Math.min(MAX_MACRO_STEP_DELAY_MS, clampDelay(s && s.delayMs)) });
      }
      deck.actions.push({ id, name, steps });
    }
  }
  if (raw.states != null) {
    if (!Array.isArray(raw.states) || raw.states.length > MAX_STATES) return { ok: false };
    for (const st of raw.states) {
      if (!st || typeof st !== 'object') return { ok: false };
      const id = typeof st.id === 'string' ? st.id.trim() : '';
      const name = cleanStr(st.name, 40);
      if (!SDK_SUB_ID_RE.test(id) || !name) return { ok: false };
      if (deck.states.some(a => a.id === id)) return { ok: false };
      deck.states.push({ id, name });
    }
  }
  if (raw.handlers != null) {
    if (!Array.isArray(raw.handlers) || raw.handlers.length > MAX_HANDLERS) return { ok: false };
    for (const h of raw.handlers) {
      if (!h || typeof h !== 'object') return { ok: false };
      const id = typeof h.id === 'string' ? h.id.trim() : '';
      const name = cleanStr(h.name, 40);
      if (!SDK_SUB_ID_RE.test(id) || !name) return { ok: false };
      if (deck.handlers.some(a => a.id === id)) return { ok: false };
      const params = normalizeHandlerParams(h.params);
      if (params === null) return { ok: false };
      deck.handlers.push({ id, name, params });
    }
  }
  return { ok: true, deck };
}

// Coerce a deck key's stored handler args (a JSON string or a plain object)
// against the handler's declared params. Returns the exact { name: value } map
// delivered to the widget, or null when the input can't be parsed. Missing
// params fall back to their default (text '', select options[0], number min) so
// a partially-configured key still fires; undeclared keys never pass through.
function validateHandlerArgs(handler, rawArgs) {
  const params = (handler && Array.isArray(handler.params)) ? handler.params : [];
  let src = rawArgs;
  if (typeof src === 'string') {
    const text = src.trim();
    if (!text) src = {};
    else { try { src = JSON.parse(text); } catch { return null; } }
  }
  if (src == null) src = {};
  if (typeof src !== 'object' || Array.isArray(src)) return null;
  const out = {};
  for (const p of params) {
    const v = src[p.name];
    if (p.kind === 'select') {
      out[p.name] = p.options.includes(v) ? v : p.options[0];
    } else if (p.kind === 'number') {
      const n = Number(v);
      out[p.name] = Number.isFinite(n) ? Math.min(p.max, Math.max(p.min, n)) : p.min;
    } else {
      out[p.name] = String(v == null ? '' : v).slice(0, HANDLER_ARG_TEXT_MAX);
    }
  }
  return out;
}

// The action-category grants a macro needs to run: one per distinct step type.
function macroCategories(macro) {
  const cats = [];
  for (const s of (macro && macro.steps) || []) {
    const cat = categoryOfActionType(s.action && s.action.type);
    if (cat && !cats.includes(cat)) cats.push(cat);
  }
  return cats;
}

// Rebuild a raw manifest into the exact shape the host trusts. Returns
// { ok:true, manifest } or { ok:false, reason } — never a spread of the input.
function normalizeManifest(raw, folderId) {
  if (!WIDGET_ID_RE.test(String(folderId || ''))) return { ok: false, reason: 'bad_id' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_manifest' };
  if (raw.api !== SDK_API_VERSION) return { ok: false, reason: 'unsupported_api' };
  // A manifest that names an id must name its own folder (no identity spoofing).
  if (raw.id != null && String(raw.id) !== folderId) return { ok: false, reason: 'id_mismatch' };
  const name = cleanStr(raw.name, 60);
  if (!name) return { ok: false, reason: 'missing_name' };
  const entry = raw.entry == null ? 'index.html' : cleanStr(raw.entry, 80);
  if (!ENTRY_RE.test(entry)) return { ok: false, reason: 'bad_entry' };
  const version = cleanStr(raw.version, 20);
  if (version && !/^[0-9A-Za-z._-]+$/.test(version)) return { ok: false, reason: 'bad_version' };
  const actions = cleanList(raw.actions, Object.keys(SDK_ACTION_CATEGORIES), Object.keys(SDK_ACTION_CATEGORIES).length);
  const hosts = normalizeHosts(raw.hosts);
  if (!hosts.ok) return { ok: false, reason: 'bad_hosts' };
  const hooks = normalizeHooks(raw.hooks);
  if (!hooks.ok) return { ok: false, reason: 'bad_hooks' };
  const deck = normalizeDeckExtras(raw.deck, actions);
  if (!deck.ok) return { ok: false, reason: 'bad_deck' };
  // Persistent storage + secrets (all opt-in, all shown in the permission
  // dialog). `storageGroup` — a shared namespace id several sibling widgets can
  // share — is validated on the package-id charset and IMPLIES `storage`, so a
  // grouped widget never has to declare both. A malformed group id rejects the
  // whole manifest (loud, like hosts/hooks).
  let storageGroup = '';
  if (raw.storageGroup != null) {
    const g = typeof raw.storageGroup === 'string' ? raw.storageGroup.trim() : '';
    if (!SDK_SUB_ID_RE.test(g)) return { ok: false, reason: 'bad_storage_group' };
    storageGroup = g;
  }
  const storage = raw.storage === true || !!storageGroup;
  const secrets = raw.secrets === true;
  return {
    ok: true,
    manifest: {
      id: folderId,
      api: SDK_API_VERSION,
      name,
      version: version || '0.0.0',
      author: cleanStr(raw.author, 60),
      description: cleanStr(raw.description, 200),
      // Persistent per-package (or per-group) key/value store, and a write-only
      // secret vault for API keys used via {{secret:NAME}} in proxied requests.
      storage,
      storageGroup,
      secrets,
      // Where the package renders: a dashboard tile (default) or the fullscreen
      // Ambient/screensaver surface. Anything but the exact literal is a tile.
      surface: raw.surface === 'ambient' ? 'ambient' : 'tile',
      // A package with handler actions may ask to run headless: the host mounts
      // a hidden sandboxed "service frame" so its deck keys answer even when no
      // tile is on screen. Meaningless without handlers → normalized to false.
      background: raw.background === true && deck.deck.handlers.length > 0,
      entry,
      streams: cleanList(raw.streams, SDK_STREAMS, SDK_STREAMS.length),
      actions,
      hosts: hosts.hosts,
      hooks: hooks.hooks,
      deck: deck.deck,
    },
  };
}

// Validate a widget's proxied fetch against its manifest. Returns the exact
// request the proxy will make ({ ok:true, url, method, headers, body }) or
// { ok:false, error }. Rules: http(s) only; hostname must be on the package's
// declared allowlist (which can never contain loopback/link-local); plain http
// only to private-network targets; headers rebuilt from an allowlist with
// control characters rejected (no header injection); body bounded.
function validateProxyRequest(manifest, raw) {
  if (!manifest || !raw || typeof raw !== 'object') return { ok: false, error: 'bad_request' };
  const urlStr = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!urlStr || urlStr.length > 4096) return { ok: false, error: 'bad_url' };
  let url;
  try { url = new URL(urlStr); } catch { return { ok: false, error: 'bad_url' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'bad_scheme' };
  if (url.username || url.password) return { ok: false, error: 'bad_url' };
  const host = normalizeProxyHost(url.hostname);
  if (!host || !(manifest.hosts || []).includes(host)) return { ok: false, error: 'host_not_allowed' };
  if (url.protocol === 'http:' && !isPrivateNetworkHost(host)) return { ok: false, error: 'https_required' };
  const method = typeof raw.method === 'string' ? raw.method.toUpperCase() : 'GET';
  if (!PROXY_METHODS.includes(method)) return { ok: false, error: 'bad_method' };
  const headers = {};
  if (raw.headers != null) {
    if (typeof raw.headers !== 'object' || Array.isArray(raw.headers)) return { ok: false, error: 'bad_headers' };
    let count = 0;
    for (const key of Object.keys(raw.headers)) {
      const name = key.toLowerCase().trim();
      if (!PROXY_HEADER_NAMES.includes(name) && !PROXY_CUSTOM_HEADER_RE.test(name)) return { ok: false, error: 'bad_headers' };
      const value = String(raw.headers[key] == null ? '' : raw.headers[key]).slice(0, 1024);
      if (/[\r\n\0]/.test(value)) return { ok: false, error: 'bad_headers' };
      headers[name] = value;
      if (++count > PROXY_MAX_HEADERS) return { ok: false, error: 'bad_headers' };
    }
  }
  let body = '';
  if (raw.body != null) {
    if (typeof raw.body !== 'string') return { ok: false, error: 'bad_body' };
    if (Buffer.byteLength(raw.body) > PROXY_BODY_MAX_BYTES) return { ok: false, error: 'body_too_large' };
    if (!['POST', 'PUT', 'PATCH'].includes(method)) return { ok: false, error: 'bad_body' };
    body = raw.body;
  }
  return { ok: true, url: url.toString(), method, headers, body };
}

// Resolve a widget asset request to an absolute path under rootDir/<id>/, or
// null. Defense in depth: id + every path segment validated against strict
// regexes (no '..', '\', '%', or empty segments survive), extension
// allowlisted, then the normalized result is prefix-checked anyway.
function resolveAsset(rootDir, id, relPath) {
  if (!WIDGET_ID_RE.test(String(id || ''))) return null;
  let decoded;
  try { decoded = decodeURIComponent(String(relPath || '')); } catch { return null; }
  if (!decoded || decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/');
  if (segments.length > 8) return null;
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..' || seg.startsWith('..')) return null;
  }
  const ext = path.extname(segments[segments.length - 1]).toLowerCase();
  if (!ASSET_MIME[ext]) return null;
  const base = path.join(rootDir, id);
  const abs = path.normalize(path.join(base, ...segments));
  if (!abs.startsWith(base + path.sep)) return null;
  return abs;
}

function mimeFor(absPath) {
  return ASSET_MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
}

// Scan the packages dir. Returns { packages:[manifest…], invalid:[{id,reason}] }.
// Bounded, async, tolerant: a broken folder shows up as invalid with a reason
// (surfaced in Settings) instead of hiding or throwing.
async function listPackages(rootDir) {
  const packages = [];
  const invalid = [];
  let entries = [];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return { packages, invalid };   // dir missing → nothing installed
  }
  for (const ent of entries) {
    if (packages.length >= MAX_PACKAGES) break;
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    if (!WIDGET_ID_RE.test(id)) { invalid.push({ id: String(id).slice(0, 60), reason: 'bad_id' }); continue; }
    let raw;
    try {
      const stat = await fs.promises.stat(path.join(rootDir, id, 'manifest.json'));
      if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) { invalid.push({ id, reason: 'bad_manifest' }); continue; }
      raw = JSON.parse(await fs.promises.readFile(path.join(rootDir, id, 'manifest.json'), 'utf8'));
    } catch {
      invalid.push({ id, reason: 'missing_manifest' });
      continue;
    }
    const res = normalizeManifest(raw, id);
    if (!res.ok) { invalid.push({ id, reason: res.reason }); continue; }
    try {
      await fs.promises.access(path.join(rootDir, id, res.manifest.entry));
    } catch {
      invalid.push({ id, reason: 'missing_entry' });
      continue;
    }
    packages.push(res.manifest);
  }
  return { packages, invalid };
}

// ── Installable package PAYLOAD (a widget shipped inside a shared bundle) ────
// A bundle can carry a widget as { id, files:[{path,data(base64)}] } and install
// it via POST /sdk/install instead of the user dropping a folder. These caps
// bound a hostile payload; the validator below is the SAME trust boundary the
// folder scan applies (manifest rebuilt, every path/extension re-checked) — for
// files arriving over the wire. Pure + unit-tested in sdk-widgets.test.mjs.
const PAYLOAD_MAX_FILES = 40;
const PAYLOAD_MAX_FILE_BYTES = 512 * 1024;
const PAYLOAD_MAX_TOTAL_BYTES = 3 * 1024 * 1024;

// One relative asset path from a payload: same per-segment charset + extension
// allowlist as resolveAsset (minus the FS). Returns the clean 'a/b.png' form, or
// '' if it isn't a safe, allowlisted asset path. '..'/backslash/percent/absolute
// are all impossible by construction.
function normalizeAssetRelPath(relPath) {
  const decoded = String(relPath == null ? '' : relPath).trim();
  if (!decoded || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('%')) return '';
  const segments = decoded.split('/');
  if (segments.length > 8) return '';
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..' || seg.startsWith('..')) return '';
  }
  const ext = path.extname(segments[segments.length - 1]).toLowerCase();
  if (!ASSET_MIME[ext]) return '';   // manifest.json (.json) is in ASSET_MIME
  return segments.join('/');
}

// Validate an embedded, installable widget package from a shared bundle:
//   { id, files:[{ path, data(base64) }] }
// Returns { ok, id, manifest, files:[{ relPath, bytes:Buffer }] } or
// { ok:false, reason }. SECURITY BOUNDARY, pure: the manifest is rebuilt through
// normalizeManifest (never spread), every file path is re-validated, size/count
// caps are enforced, and both manifest.json and the declared entry must be
// present BEFORE the caller writes a single byte.
function validateWidgetPayload(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'bad_payload' };
  const id = String(raw.id || '').trim();
  if (!WIDGET_ID_RE.test(id)) return { ok: false, reason: 'bad_id' };
  if (!Array.isArray(raw.files) || !raw.files.length || raw.files.length > PAYLOAD_MAX_FILES) return { ok: false, reason: 'bad_files' };
  const seen = new Set();
  const files = [];
  let total = 0;
  let manifestRaw = null;
  for (const f of raw.files) {
    if (!f || typeof f !== 'object') return { ok: false, reason: 'bad_files' };
    const relPath = normalizeAssetRelPath(f.path);
    if (!relPath || seen.has(relPath)) return { ok: false, reason: 'bad_path' };
    seen.add(relPath);
    let bytes;
    try { bytes = Buffer.from(String(f.data == null ? '' : f.data), 'base64'); } catch { return { ok: false, reason: 'bad_data' }; }
    if (bytes.length > PAYLOAD_MAX_FILE_BYTES) return { ok: false, reason: 'file_too_large' };
    total += bytes.length;
    if (total > PAYLOAD_MAX_TOTAL_BYTES) return { ok: false, reason: 'too_large' };
    if (relPath === 'manifest.json') {
      if (bytes.length > MANIFEST_MAX_BYTES) return { ok: false, reason: 'bad_manifest' };
      try { manifestRaw = JSON.parse(bytes.toString('utf8')); } catch { return { ok: false, reason: 'bad_manifest' }; }
    }
    files.push({ relPath, bytes });
  }
  if (!manifestRaw) return { ok: false, reason: 'missing_manifest' };
  const res = normalizeManifest(manifestRaw, id);
  if (!res.ok) return { ok: false, reason: res.reason };
  if (!files.some(f => f.relPath === res.manifest.entry)) return { ok: false, reason: 'missing_entry' };
  return { ok: true, id, manifest: res.manifest, files };
}

// ── Package origin (redistribution policy, not a security boundary) ─────────
// Where an installed package came from decides whether the user may RE-export
// it: only their own creations are shareable. Origins:
//   'import'  — arrived via a share code / bundle / community gallery
//   'creator' — built by the user (no-code Widget Creator or the AI tool)
//   'builtin' — the bundled example package
//   'local'   — a folder the developer built AND explicitly claimed as their own
//   'unknown' — no record: could be a dropped dev folder OR an install that
//               predates this tracking. FAIL-CLOSED: treated as NOT exportable
//               (we won't risk redistributing someone else's work). A developer
//               claims their own folder → 'local' to make it exportable again.
// Records live in DATA_DIR/widget-origins.json (server.js owns the store);
// these pure rules are unit-tested in sdk-widgets.test.mjs.
const WIDGET_ORIGINS = Object.freeze(['import', 'creator', 'builtin', 'local']);

// Merge a new install's origin with an existing record. Ownership is sticky:
// once a package is the user's own ('creator'/'local'), a later import-path
// reinstall (e.g. the author updating their own widget from the catalog) never
// demotes it — while a 'creator' install always claims the id (the creator can
// only overwrite an id by deliberately rebuilding it).
function mergeOrigin(prev, next) {
  const p = WIDGET_ORIGINS.includes(prev) ? prev : null;
  const n = WIDGET_ORIGINS.includes(next) ? next : 'import';
  if (n === 'creator') return 'creator';
  if (p === 'creator' || p === 'local') return p;
  return n;
}

// Only the user's own work may leave the machine as a share code. Fail-closed:
// anything we can't positively attribute to the user ('unknown', 'import',
// 'builtin', null) is NOT exportable — a dev folder becomes exportable only once
// explicitly claimed ('local').
function originExportable(origin) {
  return origin === 'creator' || origin === 'local';
}

// Read an installed package's files into an embeddable payload
// { id, files:[{ path, data(base64) }] } for a bundle export, or null. Only
// allowlisted asset files are included and the same caps apply, so a re-import
// round-trips through validateWidgetPayload.
async function readPackagePayload(rootDir, id) {
  if (!WIDGET_ID_RE.test(String(id || ''))) return null;
  const base = path.join(rootDir, id);
  const files = [];
  let total = 0;
  async function walk(dir, prefix) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length >= PAYLOAD_MAX_FILES) return;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (rel.split('/').length < 8) await walk(path.join(dir, ent.name), rel); continue; }
      const norm = normalizeAssetRelPath(rel);
      if (!norm) continue;
      let bytes;
      try { bytes = await fs.promises.readFile(path.join(dir, ent.name)); } catch { continue; }
      if (bytes.length > PAYLOAD_MAX_FILE_BYTES) continue;
      total += bytes.length;
      if (total > PAYLOAD_MAX_TOTAL_BYTES) return;
      files.push({ path: norm, data: bytes.toString('base64') });
    }
  }
  await walk(base, '');
  if (!files.some(f => f.path === 'manifest.json')) return null;
  return { id, files };
}

module.exports = {
  SDK_API_VERSION,
  SDK_STREAMS,
  SDK_ACTION_CATEGORIES,
  SDK_ACTION_TYPES,
  WIDGET_CSP,
  normalizeManifest,
  isPrivateNetworkHost,   // unit-tested (proxy allowlist boundary)
  validateProxyRequest,
  macroCategories,
  validateHandlerArgs,    // unit-tested (handler-args coercion boundary)
  resolveAsset,
  mimeFor,
  listPackages,
  validateWidgetPayload,  // unit-tested (bundle install boundary)
  readPackagePayload,
  mergeOrigin,            // unit-tested (redistribution policy)
  originExportable,
};
