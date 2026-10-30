'use strict';
// ── Xenon for widget authors: the MCP endpoint's state ──────────────────────
// Someone writing their own widget in Claude Code or Codex runs the xenon-mcp
// bridge (packages/mcp), which reaches this server over loopback. This module
// owns what that connection needs and nothing else:
//   - the connected tools: a name and a SHA-256 of a random token each, in
//     DATA_DIR/mcp-clients.json (never settings.json, which travels in backups
//     and to the dashboard), written atomically;
//   - pairing: the bridge asks, the dashboard shows "allow?", the person
//     answers, and the bridge collects its token exactly once;
//   - questions to the open dashboard (where a tile is on screen, what the
//     sandbox refused, placing a new widget), answered over /api/mcp/dev/report.
//
// Loopback is already trusted by isAllowedRequest, so the token is consent,
// revocation and a name on the work, not a wall: anything that can reach
// 127.0.0.1 could call /sdk/install itself. What it must never become is a way
// IN from elsewhere, so none of these paths is ever reachable from a paired
// device (they are absent from remotePathAllowed).

const crypto = require('crypto');
const fs = require('fs');
const { updateFileAtomic } = require('./atomic-write.js');

const MAX_CLIENTS = 10;
const MAX_PENDING_PAIRS = 3;
const PAIR_TTL_MS = 2 * 60 * 1000;
// An approved pairing waits this long for its bridge to collect the token.
const PAIR_COLLECT_MS = 60 * 1000;
const NAME_MAX = 40;
const TOKEN_PREFIX = 'xmcp_';
const ID_RE = /^[a-f0-9]{16}$/;
const QUERY_KINDS = new Set(['where', 'issues', 'place']);
const MAX_QUERIES = 8;

const OTHERS_WAIT_MS = 400;
const LIST_MAX = 20;
const TEXT_MAX = 300;

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// What the person sees in the dialog and in Settings: printable, short.
function cleanName(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return s.slice(0, NAME_MAX) || 'MCP';
}

function parseStore(raw) {
  try {
    const j = JSON.parse(String(raw || ''));
    const list = Array.isArray(j && j.clients) ? j.clients : [];
    return list
      .filter((c) => c && ID_RE.test(String(c.id)) && /^[a-f0-9]{64}$/.test(String(c.hash)))
      .slice(0, MAX_CLIENTS)
      .map((c) => ({ id: c.id, name: cleanName(c.name), hash: c.hash, createdAt: Number(c.createdAt) || 0 }));
  } catch {
    return [];
  }
}

// A dashboard's answer, cut to the fields and sizes the tools hand on. The
// dashboard is trusted (loopback), but this text reaches an AI, and errors and
// hostnames were written by the widget.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const text = (v, max = TEXT_MAX) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
function cleanReport(kind, data) {
  const found = data.found === true;
  if (kind === 'where') {
    const r = data.rect && typeof data.rect === 'object' ? data.rect : null;
    const rect = r ? { left: num(r.left), top: num(r.top), width: num(r.width), height: num(r.height), screenX: num(r.screenX), screenY: num(r.screenY) } : null;
    const ok = rect && Object.values(rect).every((v) => v !== null);
    return { found: found && !!ok, rect: ok ? rect : null, dpr: num(data.dpr) || 1 };
  }
  const list = (v) => (Array.isArray(v) ? v.slice(0, LIST_MAX) : []);
  const p = data.perf && typeof data.perf === 'object' ? data.perf : null;
  return {
    found,
    onScreen: data.onScreen === true,
    approved: data.approved === true,
    blocked: list(data.blocked).map((b) => ({ kind: text(b && b.kind, 40), ...(b && b.host ? { host: text(b.host, 255) } : {}) })),
    errors: list(data.errors).map((e) => ({ kind: text(e && e.kind, 20), message: text(e && e.message), ...(e && e.count > 1 ? { count: Math.min(9999, Math.trunc(num(e.count) || 1)) } : {}) })),
    perf: p ? { level: text(p.level, 20), longTaskMsPerMin: num(p.longTaskMsPerMin), layoutShifts: num(p.layoutShifts) } : null,
  };
}

function createMcpDev({ file, broadcast = () => {}, now = Date.now, randomBytes = crypto.randomBytes } = {}) {
  let clients = null;           // loaded on first use
  const lastUsed = new Map();   // id → ms, memory only: not worth a disk write per call
  const pairs = new Map();      // pairId → { name, status, at, token? }
  const queries = new Map();    // reqId → { kind, resolve, timer, best }

  async function load() {
    if (clients) return clients;
    let raw = null;
    try { raw = await fs.promises.readFile(file, 'utf8'); } catch { raw = null; }
    clients = parseStore(raw);
    return clients;
  }

  async function save(mutate) {
    let out;
    await updateFileAtomic(file, (raw) => {
      const list = parseStore(raw);
      out = mutate(list);
      clients = list;
      return JSON.stringify({ v: 1, clients: list }, null, 2);
    });
    return out;
  }

  function newId() { return randomBytes(8).toString('hex'); }

  function sweepPairs() {
    const t = now();
    for (const [id, p] of pairs) {
      const ttl = p.status === 'approved' ? PAIR_COLLECT_MS : PAIR_TTL_MS;
      if (t - p.at > ttl) pairs.delete(id);
    }
  }

  // ── Connected tools ──
  async function listClients() {
    const list = await load();
    return list.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: lastUsed.get(c.id) || null }));
  }

  async function authenticate(token) {
    const t = String(token || '');
    if (!t.startsWith(TOKEN_PREFIX) || t.length > 100) return null;
    const want = Buffer.from(hash(t), 'hex');
    const list = await load();
    for (const c of list) {
      const have = Buffer.from(c.hash, 'hex');
      if (have.length === want.length && crypto.timingSafeEqual(have, want)) {
        lastUsed.set(c.id, now());
        return { id: c.id, name: c.name };
      }
    }
    return null;
  }

  async function revoke(id) {
    const key = String(id || '');
    if (!ID_RE.test(key)) return false;
    await load();
    const gone = await save((list) => {
      const i = list.findIndex((c) => c.id === key);
      if (i < 0) return false;
      list.splice(i, 1);
      return true;
    });
    lastUsed.delete(key);
    if (gone) broadcast('mcp_dev_clients', { changed: true });
    return gone;
  }

  // ── Pairing ──
  function startPair(name) {
    sweepPairs();
    const waiting = [...pairs.values()].filter((p) => p.status === 'pending').length;
    if (waiting >= MAX_PENDING_PAIRS) return { ok: false, error: 'busy' };
    const id = newId();
    const p = { name: cleanName(name), status: 'pending', at: now() };
    pairs.set(id, p);
    // The time left goes with it, so a dialog closes when the pairing expires
    // instead of offering an Allow the server would refuse.
    broadcast('mcp_dev_pair', { id, name: p.name, expiresInMs: PAIR_TTL_MS });
    return { ok: true, pairId: id, expiresInMs: PAIR_TTL_MS };
  }

  // The pairings still waiting, for a dashboard that opens after the request.
  function pendingPairs() {
    sweepPairs();
    const t = now();
    return [...pairs].filter(([, p]) => p.status === 'pending')
      .map(([id, p]) => ({ id, name: p.name, expiresInMs: Math.max(0, PAIR_TTL_MS - (t - p.at)) }));
  }

  async function answerPair(pairId, allow) {
    sweepPairs();
    const p = pairs.get(String(pairId || ''));
    if (!p || p.status !== 'pending') return { ok: false, error: 'not_found' };
    if (!allow) {
      p.status = 'denied';
      p.at = now();
      broadcast('mcp_dev_pair_done', { id: pairId });
      return { ok: true };
    }
    await load();
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const id = newId();
    const full = await save((list) => {
      if (list.length >= MAX_CLIENTS) return true;
      list.push({ id, name: p.name, hash: hash(token), createdAt: now() });
      return false;
    });
    if (full) return { ok: false, error: 'too_many' };
    p.status = 'approved';
    p.token = token;
    p.at = now();
    broadcast('mcp_dev_pair_done', { id: pairId });
    broadcast('mcp_dev_clients', { changed: true });
    return { ok: true };
  }

  // The bridge asks until there is an answer. The token leaves exactly once.
  function pollPair(pairId) {
    sweepPairs();
    const key = String(pairId || '');
    const p = pairs.get(key);
    if (!p) return { status: 'expired' };
    if (p.status === 'approved') {
      pairs.delete(key);
      return { status: 'approved', token: p.token };
    }
    if (p.status === 'denied') {
      pairs.delete(key);
      return { status: 'denied' };
    }
    return { status: 'pending' };
  }

  // ── Questions to the open dashboard ──
  // Every loopback dashboard hears the question; the first useful answer wins.
  // For 'place' the first dashboard to answer is the only one told to act, so
  // two open windows never put the same widget on the page twice.
  function ask(kind, args, timeoutMs = 2500) {
    if (!QUERY_KINDS.has(kind)) return Promise.resolve(null);
    if (queries.size >= MAX_QUERIES) return Promise.resolve(null);
    const reqId = newId();
    return new Promise((resolve) => {
      const q = { kind, resolve, best: null, timer: null };
      q.timer = setTimeout(() => finish(reqId), Math.max(200, Math.min(10000, timeoutMs)));
      if (q.timer.unref) q.timer.unref();
      queries.set(reqId, q);
      broadcast('mcp_dev_query', { reqId, kind, ...(args || {}) });
    });
  }

  function finish(reqId) {
    const q = queries.get(reqId);
    if (!q) return;
    clearTimeout(q.timer);
    queries.delete(reqId);
    q.resolve(q.best);
  }

  // One dashboard's answer. Returns whether it was taken (for 'place', whether
  // THIS dashboard should act).
  function report(reqId, data) {
    const key = String(reqId || '');
    const q = queries.get(key);
    if (!q || !data || typeof data !== 'object') return false;
    if (q.kind === 'place') {
      q.best = { placed: true };
      finish(key);
      return true;
    }
    // 'where' and 'issues': a dashboard that has the tile on screen beats one
    // that does not; the first that does ends the wait. One that does not gives
    // the others a moment more, not the whole timeout.
    const clean = cleanReport(q.kind, data);
    if (clean.found) {
      q.best = clean;
      finish(key);
      return true;
    }
    if (!q.best) {
      q.best = clean;
      clearTimeout(q.timer);
      q.timer = setTimeout(() => finish(key), OTHERS_WAIT_MS);
      if (q.timer.unref) q.timer.unref();
    }
    return true;
  }

  function close() {
    for (const id of [...queries.keys()]) finish(id);
    pairs.clear();
  }

  return { listClients, authenticate, revoke, startPair, pendingPairs, answerPair, pollPair, ask, report, close };
}

module.exports = { createMcpDev, cleanName, cleanReport, parseStore, TOKEN_PREFIX, PAIR_TTL_MS, MAX_CLIENTS };
