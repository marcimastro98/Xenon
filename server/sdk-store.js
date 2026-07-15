'use strict';
// Third-party widget SDK — persistent storage + secret store (pure logic).
//
// The SDK's sandbox deliberately denies a widget cookies/localStorage (opaque
// origin, `connect-src 'none'`), so a widget has nowhere to keep its own
// settings — the exact gap that forced authors to edit core files and get wiped
// on every update. This module is the SECURITY BOUNDARY for two host-mediated
// stores that fill it without weakening the sandbox:
//
//   • a per-package key/value STORE (the widget's own settings — followed teams,
//     chosen news sources, a map's last centre), optionally SHARED across a set
//     of widgets that declare the same `storageGroup`; and
//   • a per-package SECRET store for API keys: values are WRITE-ONLY from the
//     widget's side (a read returns only the names, never the values), and they
//     are injected into the widget's OWN outbound requests server-side via
//     `{{secret:NAME}}` placeholders — so a published package ships no keys and
//     the sandboxed frame never sees them.
//
// Everything here is pure (no fs, no server state) and unit-tested in
// server/test/sdk-store.test.mjs; server.js owns the on-disk persistence and the
// grant/rate gates around these functions.

// ── Key/value store ─────────────────────────────────────────────────────────
// Keys: a conservative filename-ish charset (no traversal, safe as an object
// key). Values: any JSON-serialisable value, bounded by its serialised size —
// the widget can keep a small settings object without hand-rolling a string.
const STORE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STORE_MAX_KEYS = 128;
const STORE_MAX_VALUE_BYTES = 16 * 1024;
const STORE_MAX_TOTAL_BYTES = 256 * 1024;
const STORE_OPS = Object.freeze(['get', 'set', 'delete', 'keys', 'clear']);

// ── Secret store ────────────────────────────────────────────────────────────
// Secrets are always strings (an API key/token). Small count + size caps: this
// is a credential vault, not a data store.
const SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_MAX_COUNT = 16;
const SECRET_MAX_VALUE_BYTES = 4 * 1024;
const SECRET_OPS = Object.freeze(['set', 'delete', 'names', 'has']);
// `{{secret:NAME}}` (optional inner whitespace). Global — a request may weave in
// several. The captured name is re-checked against SECRET_NAME_RE on use.
const SECRET_PLACEHOLDER_RE = /\{\{\s*secret:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*\}\}/g;

// A control character in a secret would let a stored value inject a header
// (CRLF) once substituted; reject at write time so substitution is always safe.
function isCleanSecretValue(v) {
  return typeof v === 'string' && !/[\r\n\0]/.test(v);
}

function normalizeStoreKey(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  return STORE_KEY_RE.test(k) ? k : '';
}

// Serialised byte size of a JSON value, or -1 if it can't be serialised (a
// cycle, a BigInt, undefined at the top level…). The store only accepts values
// that round-trip through JSON, since that's how they're persisted.
function jsonBytes(value) {
  let s;
  try { s = JSON.stringify(value); } catch { return -1; }
  if (typeof s !== 'string') return -1;   // value was `undefined`
  return Buffer.byteLength(s, 'utf8');
}

// Apply ONE store op to a namespace's current map, returning a fresh result.
// Pure: never mutates `current`. Shape:
//   { ok:true, store, changed, value?, keys? }  |  { ok:false, error }
// `store` is the (possibly new) map to persist; `changed` says whether it
// differs from `current` so the caller can skip a needless disk write.
function applyStoreOp(current, op) {
  const store = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
  if (!op || typeof op !== 'object') return { ok: false, error: 'bad_request' };
  const kind = op.op;
  if (!STORE_OPS.includes(kind)) return { ok: false, error: 'bad_op' };

  if (kind === 'keys') {
    return { ok: true, store, changed: false, keys: Object.keys(store) };
  }
  if (kind === 'clear') {
    if (!Object.keys(store).length) return { ok: true, store, changed: false };
    return { ok: true, store: {}, changed: true };
  }

  const key = normalizeStoreKey(op.key);
  if (!key) return { ok: false, error: 'bad_key' };

  if (kind === 'get') {
    return { ok: true, store, changed: false, value: Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null };
  }
  if (kind === 'delete') {
    if (!Object.prototype.hasOwnProperty.call(store, key)) return { ok: true, store, changed: false };
    const next = { ...store };
    delete next[key];
    return { ok: true, store: next, changed: true };
  }
  // set
  const size = jsonBytes(op.value);
  if (size < 0) return { ok: false, error: 'bad_value' };
  if (size > STORE_MAX_VALUE_BYTES) return { ok: false, error: 'value_too_large' };
  const isNew = !Object.prototype.hasOwnProperty.call(store, key);
  if (isNew && Object.keys(store).length >= STORE_MAX_KEYS) return { ok: false, error: 'too_many_keys' };
  const next = { ...store, [key]: op.value };
  if (jsonBytes(next) > STORE_MAX_TOTAL_BYTES) return { ok: false, error: 'store_full' };
  return { ok: true, store: next, changed: true };
}

function normalizeSecretName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  return SECRET_NAME_RE.test(n) ? n : '';
}

// Apply ONE secret op to a package's current secret map, returning a fresh
// result. Pure. CRUCIAL: a read NEVER yields a value — only names or existence
// — so a compromised bridge can't exfiltrate a stored key. Shape mirrors
// applyStoreOp; `names`/`has` are read ops (changed:false).
function applySecretOp(current, op) {
  const secrets = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
  if (!op || typeof op !== 'object') return { ok: false, error: 'bad_request' };
  const kind = op.op;
  if (!SECRET_OPS.includes(kind)) return { ok: false, error: 'bad_op' };

  if (kind === 'names') {
    return { ok: true, secrets, changed: false, names: Object.keys(secrets) };
  }
  const name = normalizeSecretName(op.name);
  if (!name) return { ok: false, error: 'bad_name' };
  if (kind === 'has') {
    return { ok: true, secrets, changed: false, has: Object.prototype.hasOwnProperty.call(secrets, name) };
  }
  if (kind === 'delete') {
    if (!Object.prototype.hasOwnProperty.call(secrets, name)) return { ok: true, secrets, changed: false };
    const next = { ...secrets };
    delete next[name];
    return { ok: true, secrets: next, changed: true };
  }
  // set
  if (!isCleanSecretValue(op.value)) return { ok: false, error: 'bad_value' };
  if (Buffer.byteLength(op.value, 'utf8') > SECRET_MAX_VALUE_BYTES) return { ok: false, error: 'value_too_large' };
  const isNew = !Object.prototype.hasOwnProperty.call(secrets, name);
  if (isNew && Object.keys(secrets).length >= SECRET_MAX_COUNT) return { ok: false, error: 'too_many_secrets' };
  return { ok: true, secrets: { ...secrets, [name]: op.value }, changed: true };
}

// Replace every `{{secret:NAME}}` in `text` with the stored secret. Returns
// { ok:true, text } or { ok:false, error:'unknown_secret', name } — an
// unresolved placeholder is a hard error (never send the literal token to an
// API, and never silently drop an intended credential). `secrets` is the raw
// name→value map; a name outside SECRET_NAME_RE can't be a key so it's "unknown".
function resolveSecretsInText(text, secrets) {
  const src = String(text == null ? '' : text);
  if (src.indexOf('{{') === -1) return { ok: true, text: src };
  const map = (secrets && typeof secrets === 'object') ? secrets : {};
  let bad = null;
  const out = src.replace(SECRET_PLACEHOLDER_RE, (_m, name) => {
    if (Object.prototype.hasOwnProperty.call(map, name)) return String(map[name]);
    bad = name;
    return '';
  });
  if (bad) return { ok: false, error: 'unknown_secret', name: bad };
  return { ok: true, text: out };
}

// Resolve secret placeholders across an ALREADY-VALIDATED proxy request
// (sdk-widgets.validateProxyRequest output: { url, method, headers, body }).
// Substitution happens in the url, every header value and the body. Then the
// resolved url is re-parsed and its host is required to be UNCHANGED and still
// on the allowlist — so a secret can never move the request to a new host, and
// the re-validated header values can't smuggle a CRLF (already blocked at write
// time, re-checked here as defence in depth). Returns { ok:true, req } or
// { ok:false, error }.
function resolveProxySecrets(req, secrets, allowedHosts) {
  if (!req || typeof req !== 'object') return { ok: false, error: 'bad_request' };
  const origHost = hostOf(req.url);

  const u = resolveSecretsInText(req.url, secrets);
  if (!u.ok) return { ok: false, error: u.error };
  const newHost = hostOf(u.text);
  const allow = Array.isArray(allowedHosts) ? allowedHosts : [];
  if (!newHost || newHost !== origHost || !allow.includes(newHost)) return { ok: false, error: 'secret_host_change' };

  const headers = {};
  for (const name of Object.keys(req.headers || {})) {
    const r = resolveSecretsInText(req.headers[name], secrets);
    if (!r.ok) return { ok: false, error: r.error };
    if (/[\r\n\0]/.test(r.text)) return { ok: false, error: 'bad_headers' };
    headers[name] = r.text;
  }

  let body = req.body;
  if (typeof body === 'string' && body) {
    const b = resolveSecretsInText(body, secrets);
    if (!b.ok) return { ok: false, error: b.error };
    body = b.text;
  }
  return { ok: true, req: { url: u.text, method: req.method, headers, body } };
}

function hostOf(urlStr) {
  try { return new URL(String(urlStr || '')).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return ''; }
}

// A package's store lives under its own id, UNLESS it opts into a shared group —
// then every package declaring the same `storageGroup` reads/writes one shared
// namespace (so a set of sibling widgets can share config/cache). Group ids are
// namespaced ('g:') so they can never collide with a package id.
function storeNamespace(manifest) {
  const group = manifest && typeof manifest.storageGroup === 'string' ? manifest.storageGroup : '';
  if (group) return 'g:' + group;
  return manifest && manifest.id ? String(manifest.id) : '';
}

module.exports = {
  STORE_KEY_RE,
  STORE_MAX_KEYS,
  STORE_MAX_VALUE_BYTES,
  STORE_MAX_TOTAL_BYTES,
  STORE_OPS,
  SECRET_NAME_RE,
  SECRET_MAX_COUNT,
  SECRET_MAX_VALUE_BYTES,
  SECRET_OPS,
  normalizeStoreKey,
  applyStoreOp,
  normalizeSecretName,
  applySecretOp,
  resolveSecretsInText,
  resolveProxySecrets,
  storeNamespace,
};
