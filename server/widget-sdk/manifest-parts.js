'use strict';
// Cleans the parts of a widget's manifest one by one: text and lists, the hosts it asks for and
// the ones the user fills in, hooks, and what a key handler takes.

const DeckShortcuts = require('../js/deck-shortcuts.js');
const { categoryOfActionType } = require('./surface.js');
const { SDK_SUB_ID_RE } = require('./package-names.js');
const {
  MAX_HOSTS, MAX_USER_HOSTS, USER_HOST_SCOPES, MAX_HOOKS, MAX_HANDLER_PARAMS, HANDLER_PARAM_KINDS,
  HANDLER_ARG_TEXT_MAX,
} = require('./manifest-limits.js');
const { isPrivateNetworkHost, normalizeProxyHost } = require('./proxy-request.js');

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

// userHosts: NAMED BLANKS the user fills in at approval time. The author cannot
// know the reader's LAN address, so a NAS/Docker/self-hosted widget that hard-
// codes one in `hosts` only ever works on the author's own machine — which is
// why such a widget cannot be published at all today. A slot declares the id the
// widget reads the value back under, the label the user sees above the field,
// and how wide the field may reach ('private' = LAN only, the default; 'any' =
// also public names, for a self-hosted service on its own domain).
//
// The package still never chooses its own destination — that property is what
// the whole proxy allowlist exists to protect. It only declares that it NEEDS an
// address and what for; the address itself comes from the person who owns the
// machine. See resolveUserHosts for the enforcement half.
//
// A duplicate id is an author bug (two labels, one slot, second silently wins),
// so it rejects the manifest like every other malformed entry.
function normalizeUserHosts(raw) {
  if (raw == null) return { ok: true, userHosts: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false };
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!SDK_SUB_ID_RE.test(id)) return { ok: false };
    if (out.some(s => s.id === id)) return { ok: false };
    const label = cleanStr(item.label, 60);
    if (!label) return { ok: false };
    const scope = item.scope == null ? 'private' : item.scope;
    if (!USER_HOST_SCOPES.includes(scope)) return { ok: false };
    out.push({ id, label, scope });
    if (out.length > MAX_USER_HOSTS) return { ok: false };
  }
  return { ok: true, userHosts: out };
}

// Resolve the addresses the USER typed into a manifest's declared slots into the
// extra hosts the proxy allowlist accepts for this package, plus a ready-to-use
// `base` per slot the widget can concatenate a path onto.
//
// The security contract, in one line: a slot can only ever resolve to a host the
// manifest could have declared legally itself. Every value is re-validated here,
// at request time, against the SAME normalizeProxyHost the install path uses —
// so loopback, link-local and `localhost` are unreachable through a slot no
// matter what a tampered settings blob claims, and 'private' scope additionally
// pins the value to LAN space. guardedLookup in sdk-proxy.js still has the last
// word at connect time, so a name that RESOLVES back to 127.0.0.1 dies there.
//
// Unlike normalizeUserHosts (author data, validated once at install, rejects
// loud) this is USER data re-read on every request: a value that no longer
// passes — a widget update narrowed the scope, someone hand-edited settings — is
// skipped, not fatal. The slot then reads as "not configured" and the widget's
// fetch fails with host_not_allowed, which is the same state it starts in.
function resolveUserHosts(manifest, granted) {
  const slots = (manifest && Array.isArray(manifest.userHosts)) ? manifest.userHosts : [];
  const values = (granted && typeof granted === 'object' && !Array.isArray(granted)) ? granted : {};
  const byId = {};
  const hosts = [];
  for (const slot of slots) {
    const v = values[slot.id];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const host = normalizeProxyHost(v.host);
    if (!host) continue;
    const priv = isPrivateNetworkHost(host);
    if (slot.scope === 'private' && !priv) continue;
    // Mirror the proxy's own http-vs-https rule rather than restating it: a
    // public host is only ever reachable over TLS, so its base must say https
    // whatever was stored. LAN gear rarely has a cert, so there the user's
    // choice stands and plain http is the default.
    const scheme = priv ? (v.scheme === 'https' ? 'https' : 'http') : 'https';
    const port = Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535 ? v.port : 0;
    byId[slot.id] = { host, port, scheme, base: `${scheme}://${host}${port ? ':' + port : ''}` };
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { byId, hosts };
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
// A key combination the creator suggests: for showing the widget (top-level
// `key`, with `mode` "toggle" or "hold") or for one of its functions
// (`deck.handlers[].key`). It is only ever OFFERED to the person in the Xenon
// menu, never set on install, so it needs no grant; like every cosmetic field a
// malformed or reserved one is dropped and never rejects the package.
function normalizeKeySuggestion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const combo = DeckShortcuts.normalizeShortcut(typeof raw.combo === 'string' ? raw.combo : '');
  if (!combo || DeckShortcuts.reservedBy(combo)) return null;
  return { combo, mode: raw.mode === 'hold' ? 'hold' : 'toggle' };
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

module.exports = {
  cleanStr, cleanList, normalizeHosts, normalizeUserHosts, resolveUserHosts, normalizeHooks,
  normalizeHandlerParams, normalizeKeySuggestion, validateHandlerArgs, macroCategories,
};
