'use strict';

// ── The command OpenAI Codex runs for Xenon's hooks ──────────────────────────
//   node codex-hook.js event        a lifecycle event: forwarded, nothing printed
//   node codex-hook.js permission   an approval: forwarded, and the hub's answer
//                                   printed for Codex IF it is a valid decision
//
// Codex hooks can only be commands (no HTTP handler exists), so this is the
// small bridge between Codex and the hub, written by codex-link.js. It is the
// twin of claude-statusline.js in spirit and keeps the same promises:
//
//   • It can never make Codex worse. Hub down, wrong token, a timeout, a body
//     that is not a decision: it prints NOTHING and exits 0, and "no decision"
//     is Codex's own cue to show its normal approval prompt. Nothing here can
//     turn a non-answer into an allow.
//   • It never writes to stderr (Codex would surface it) and never throws.
//   • The token and port come from DATA_DIR/codex-bridge.json next to this
//     file, never from the command line, so they do not show in a process list.
//
// Only node built-ins: this runs once per hook, so it must start fast.

const fs = require('fs');
const path = require('path');
const http = require('http');

const MAX_INPUT = 1024 * 1024;
const STDIN_IDLE_MS = 1500;       // Codex writes the payload at once; a stalled pipe is not a payload
const CONNECT_MS = 400;           // the hub is on this machine: no answer this fast means it is not running
const EVENT_TOTAL_MS = 3000;
const PERMISSION_TOTAL_MS = 11 * 60 * 1000;   // Codex's own limit (600 s) ends us first

function done() { process.exit(0); }

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'codex-bridge.json'), 'utf8'));
    const port = Number.isInteger(s.port) && s.port > 0 && s.port <= 65535 ? s.port : 3030;
    return typeof s.token === 'string' && s.token.length >= 32 ? { token: s.token, port } : null;
  } catch { return null; }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let timer = null;
    const finish = () => { clearTimeout(timer); resolve(buf); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(finish, STDIN_IDLE_MS); };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_INPUT) { buf = ''; finish(); return; }
      arm();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    arm();
  });
}

// The only shape that is ever printed back to Codex, rebuilt from scratch:
// whatever else the hub's body contained is not passed through.
function decisionFrom(body) {
  let j;
  try { j = JSON.parse(body); } catch { return null; }
  const out = j && j.hookSpecificOutput;
  const d = out && out.decision;
  if (!out || out.hookEventName !== 'PermissionRequest' || !d) return null;
  if (d.behavior === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  if (d.behavior === 'deny') {
    const message = typeof d.message === 'string' && d.message.trim() ? d.message.trim().slice(0, 500) : 'Denied from Xenon';
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
  }
  return null;
}

function post(state, mode, payload, totalMs) {
  return new Promise((resolve) => {
    let settled = false;
    const end = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({
      host: '127.0.0.1', port: state.port, method: 'POST', path: '/api/codex/' + mode,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Xenon-Bridge': state.token },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 64 * 1024) body += d; });
      res.on('end', () => end(res.statusCode === 200 ? body : ''));
      res.on('error', () => end(''));
    });
    const connect = setTimeout(() => { if (!req.socket || req.socket.connecting) { req.destroy(); end(''); } }, CONNECT_MS);
    const total = setTimeout(() => { req.destroy(); end(''); }, totalMs);
    req.on('socket', (s) => s.once('connect', () => clearTimeout(connect)));
    req.on('error', () => end(''));
    req.on('close', () => { clearTimeout(connect); clearTimeout(total); });
    req.end(payload);
  });
}

async function main() {
  const mode = process.argv[2] === 'permission' ? 'permission' : process.argv[2] === 'event' ? 'event' : '';
  if (!mode) return done();
  const state = readState();
  const input = await readStdin();
  if (!state || !input.trim()) return done();
  try { JSON.parse(input); } catch { return done(); }
  const body = await post(state, mode, input, mode === 'permission' ? PERMISSION_TOTAL_MS : EVENT_TOTAL_MS);
  if (mode === 'permission') {
    const d = decisionFrom(body);
    if (d) process.stdout.write(JSON.stringify(d) + '\n', done);
    else done();
  } else done();
}

if (require.main === module) {
  process.on('uncaughtException', done);
  process.on('unhandledRejection', done);
  main().catch(done);
}

module.exports = { decisionFrom, _internal: { CONNECT_MS, STDIN_IDLE_MS } };
