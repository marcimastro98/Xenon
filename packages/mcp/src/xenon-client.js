'use strict';
// Talking to Xenon on this computer: one POST per tool call to
// /api/mcp/dev/call, with the token this bridge got when the person said yes
// on the dashboard. The first call pairs: Xenon shows "Let this tool build
// widgets?", and the token comes back once and is kept in ~/.xenon/mcp.json
// (only for this user, one per Xenon address). A token Xenon no longer knows
// (removed in Settings) starts a new pairing.
//
// Loopback only: the token must never travel to another machine.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const DEFAULT_URL = 'http://127.0.0.1:3030';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CALL_TIMEOUT_MS = 60 * 1000;
// How long one tool call waits for the person to answer the dialog before it
// says "approve it, then call again". Xenon keeps the request for 2 minutes.
const PAIR_WAIT_MS = 90 * 1000;
const POLL_MS = 1000;

class XenonError extends Error {
  constructor(code, hint) { super(hint || code); this.code = code; this.hint = hint || ''; }
}

function xenonUrl(env = process.env) {
  const raw = String(env.XENON_URL || DEFAULT_URL).replace(/\/+$/, '');
  let u;
  try { u = new URL(raw); } catch { throw new XenonError('bad_url', 'XENON_URL is not a valid address.'); }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) throw new XenonError('bad_url', 'XENON_URL must be a loopback address such as http://127.0.0.1:3030.');
  return u.origin;
}

function storeFile(env = process.env) {
  return env.XENON_MCP_STORE || path.join(os.homedir(), '.xenon', 'mcp.json');
}

function readStore(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && j.servers && typeof j.servers === 'object' ? j : { servers: {} };
  } catch { return { servers: {} }; }
}

// Written to a temp file then renamed, readable only by this user.
function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function request(origin, method, sub, body, token) {
  const u = new URL('/api/mcp/dev/' + sub, origin);
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers['X-Xenon-Mcp-Token'] = token;
    const req = http.request({
      hostname: u.hostname === '[::1]' ? '::1' : u.hostname, port: u.port, path: u.pathname, method, headers, timeout: CALL_TIMEOUT_MS,
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(out); } catch { /* handled below */ }
        if (res.statusCode === 401) { reject(new XenonError('not_paired')); return; }
        if (res.statusCode === 404) { reject(new XenonError('old_xenon', 'This Xenon is too old for xenon-mcp. Update Xenon, then try again.')); return; }
        if (!j) { reject(new XenonError('bad_answer', 'Xenon answered with something that is not JSON.')); return; }
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new XenonError('timeout', 'Xenon did not answer in time.')));
    req.on('error', (e) => {
      if (e instanceof XenonError) { reject(e); return; }
      reject(new XenonError('not_running', `Xenon is not running on this computer (${origin}). Start Xenon, then try again.`));
    });
    req.end(data || undefined);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createClient({ name = 'MCP', env = process.env, wait = sleep, pairWaitMs = PAIR_WAIT_MS } = {}) {
  const origin = xenonUrl(env);
  const file = storeFile(env);
  let pairId = null;   // a pairing still waiting for the person, across calls

  const saved = () => (readStore(file).servers[origin] || {}).token || '';
  function save(token) {
    const store = readStore(file);
    if (token) store.servers[origin] = { token, pairedAt: new Date().toISOString() };
    else delete store.servers[origin];
    writeStore(file, store);
  }

  async function pair() {
    if (!pairId) {
      const r = await request(origin, 'POST', 'pair', { name });
      if (!r.ok) throw new XenonError(r.error || 'pair_failed', r.error === 'busy' ? 'Xenon already has requests waiting. Answer them on the dashboard, then try again.' : 'Xenon refused to pair.');
      pairId = r.pairId;
    }
    const until = Date.now() + pairWaitMs;
    while (Date.now() < until) {
      const r = await request(origin, 'POST', 'pair/poll', { pairId });
      if (r.status === 'approved' && r.token) { pairId = null; save(r.token); return r.token; }
      if (r.status === 'denied') { pairId = null; throw new XenonError('denied', 'The person said no on the Xenon dashboard.'); }
      if (r.status === 'expired') { pairId = null; throw new XenonError('expired', 'Nobody answered on the Xenon dashboard in time. Try again and approve it there.'); }
      await wait(POLL_MS);
    }
    throw new XenonError('waiting', 'Xenon is asking on its dashboard whether to let this tool build widgets. Ask the person to press Allow there, then call the tool again.');
  }

  // One op on Xenon. Pairs first when there is no token, or when Xenon
  // forgot this one (removed in Settings), once.
  async function call(op, args) {
    let token = saved() || await pair();
    try {
      return await request(origin, 'POST', 'call', { op, args }, token);
    } catch (e) {
      if (!(e instanceof XenonError) || e.code !== 'not_paired') throw e;
      save('');
      token = await pair();
      return request(origin, 'POST', 'call', { op, args }, token);
    }
  }

  return { call, origin };
}

module.exports = { createClient, xenonUrl, storeFile, readStore, XenonError, DEFAULT_URL };
