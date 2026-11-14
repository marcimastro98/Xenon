'use strict';
// Reads the list of Ollama models Xenon offers to download: the fetch with its size and time
// limits, and each entry cleaned.

const https = require('node:https');
const { armDeadline } = require('../net-guard.js');

const MAX_BODY_BYTES = 256 * 1024;   // a model list; anything larger is not one
const MAX_CATALOG_MODELS = 60;
const FETCH_TIMEOUT_MS = 8000;
// `timeout` on https.get is an idle timeout only; a server trickling bytes
// would keep the request (and the refresh it belongs to) open forever. This
// bounds the whole request.
const FETCH_DEADLINE_MS = 15000;

const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,40}(?::[a-z0-9][a-z0-9._-]{0,40})?$/;
const KNOWN_CAPS = ['tools', 'vision'];

function _num(value, min, max) {
  const n = Number(value);
  return (Number.isFinite(n) && n >= min && n <= max) ? n : 0;
}

// Explicit key-by-key rebuild, never a spread of the parsed payload.
function normalizeCatalogModel(m) {
  if (!m || typeof m !== 'object') return null;
  const tag = typeof m.tag === 'string' ? m.tag.trim().toLowerCase() : '';
  if (!TAG_RE.test(tag)) return null;
  const caps = Array.isArray(m.capabilities)
    ? m.capabilities.filter(c => KNOWN_CAPS.includes(c))
    : [];
  return {
    tag,
    label: typeof m.label === 'string' && m.label ? m.label.slice(0, 60) : tag,
    sizeGB: _num(m.sizeGB, 0.1, 500),
    vramGB: _num(m.vramGB, 1, 128),
    ramGB: _num(m.ramGB, 1, 512),
    capabilities: caps,
  };
}

function normalizeCatalog(payload) {
  const list = payload && Array.isArray(payload.models) ? payload.models : [];
  const out = [];
  const seen = new Set();
  for (const m of list) {
    const n = normalizeCatalogModel(m);
    if (!n || seen.has(n.tag)) continue;
    seen.add(n.tag);
    out.push(n);
    if (out.length >= MAX_CATALOG_MODELS) break;
  }
  return out;
}

// HTTPS conditional GET. Mirrors fetchText in community-catalog.js (same
// redirect cap, timeout, body cap, ETag handling) — the codebase convention for
// these fetchers is a documented mirror. If you harden one, harden all.
function _fetchText(url, etag, _hops = 0) {
  return new Promise((resolve, reject) => {
    if (_hops > 5) return reject(new Error('too many redirects'));
    if (!/^https:\/\//i.test(url)) return reject(new Error('https only'));
    const headers = etag ? { 'If-None-Match': etag } : {};
    let req;
    try { req = https.get(url, { timeout: FETCH_TIMEOUT_MS, headers }, onResponse); }
    catch (e) { return reject(e); }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    armDeadline(req, FETCH_DEADLINE_MS);

    function onResponse(res) {
      if (res.statusCode === 304) { res.resume(); return resolve({ notModified: true }); }
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(_fetchText(new URL(res.headers.location, url).toString(), etag, _hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const tag = res.headers.etag || '';
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ notModified: false, text: Buffer.concat(chunks).toString('utf8'), etag: tag }));
      res.on('error', reject);
    }
  });
}

module.exports = {
  MAX_BODY_BYTES, MAX_CATALOG_MODELS, FETCH_TIMEOUT_MS, FETCH_DEADLINE_MS, TAG_RE, KNOWN_CAPS, _num,
  normalizeCatalogModel, normalizeCatalog, _fetchText,
};
