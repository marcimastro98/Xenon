'use strict';

// Local Ollama models: list with sizes, remove the ones the user picks. Talks to
// the same loopback-only Ollama URL the AI tile uses. The model Xenon itself
// runs (the resolved `ollamaModel`) and the crash fallback are protected: they
// are listed so the total adds up, but never offered.

const http = require('http');
const aiLocal = require('./ai-local.js');
const { stableId } = require('./devclean-ids.js');

const CRASH_FALLBACK = 'qwen2.5:3b';

// Same name test as ai-local's crash fallback: exact tag, or a variant of it.
const sameModel = (name, tag) => {
  const n = String(name || '').toLowerCase();
  const t = String(tag || '').toLowerCase();
  return !!t && (n === t || n.startsWith(t + '-') || n === t + ':latest');
};

function ollamaRequest(baseUrl, method, route, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(route, baseUrl); } catch { return resolve({ ok: false }); }
    const payload = body ? JSON.stringify(body) : null;
    // family: 4 — Ollama listens on 127.0.0.1 and "localhost" resolves to ::1
    // first on Windows (see _ollamaReachable in ai-local.js).
    const req = http.request({
      hostname: u.hostname, port: u.port || 11434, path: u.pathname, method, family: 4,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (data.length < 4 * 1024 * 1024) data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON body */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false }); });
    req.end(payload || undefined);
  });
}

function createOllamaSource({ getSettings, request = ollamaRequest }) {
  let ids = new Map(); // opaque id -> model name, from the last overview

  async function context() {
    const s = (await Promise.resolve(getSettings()).catch(() => null)) || {};
    const baseUrl = aiLocal.sanitizeOllamaUrl(s.ollamaUrl) || aiLocal.DEFAULT_OLLAMA_URL;
    const active = aiLocal.resolveModel(s.ollamaModel, s.hardwareScan);
    return { baseUrl, protectedTags: [active, CRASH_FALLBACK] };
  }

  async function listModels(baseUrl) {
    const res = await request(baseUrl, 'GET', '/api/tags', null, 3000);
    if (!res.ok) return null;
    const models = Array.isArray(res.json && res.json.models) ? res.json.models : [];
    return models
      .filter((m) => m && typeof m.name === 'string' && m.name)
      .map((m) => ({ name: m.name, bytes: Number.isFinite(m.size) ? m.size : 0 }));
  }

  async function overview() {
    const { baseUrl, protectedTags } = await context();
    const models = await listModels(baseUrl);
    if (!models) return { available: false, reason: 'not_running' };
    ids = new Map();
    const items = models
      .sort((a, b) => b.bytes - a.bytes)
      .map((m) => {
        const id = stableId('m', m.name);
        ids.set(id, m.name);
        const isProtected = protectedTags.some((t) => sameModel(m.name, t));
        return { id, kind: 'model', name: m.name, bytes: m.bytes, protected: isProtected };
      });
    const bytes = items.reduce((n, it) => n + it.bytes, 0);
    const reclaimable = items.filter((it) => !it.protected).reduce((n, it) => n + it.bytes, 0);
    return { available: true, bytes, reclaimable, items };
  }

  // Re-lists and re-checks protection right before removing: the setting or
  // the installed set may have changed since the overview the ids came from.
  async function clean(selected) {
    const { baseUrl, protectedTags } = await context();
    const models = await listModels(baseUrl);
    if (!models) return { ok: false, error: 'not_running', freed: 0, failed: selected };
    const byName = new Map(models.map((m) => [m.name, m]));
    let freed = 0;
    const failed = [];
    for (const id of selected) {
      const name = ids.get(id);
      const model = name && byName.get(name);
      if (!model || protectedTags.some((t) => sameModel(name, t))) { failed.push(id); continue; }
      const res = await request(baseUrl, 'DELETE', '/api/delete', { model: name, name }, 60000);
      if (res.ok) freed += model.bytes; else failed.push(id);
    }
    return { ok: failed.length === 0, freed, failed };
  }

  return { overview, clean };
}

module.exports = { createOllamaSource, sameModel, CRASH_FALLBACK };
