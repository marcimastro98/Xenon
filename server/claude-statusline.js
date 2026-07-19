'use strict';

// ── Xenon statusline bridge ──────────────────────────────────────────────────
// Claude Code runs this on every assistant message and hands it the session JSON
// on stdin. Two jobs:
//
//   1. POST that JSON to the hub. It is the only supported source of the real
//      subscription quota (rate_limits.five_hour / .seven_day), plus live model,
//      cost and context-window figures the transcript reader cannot see.
//   2. Print a status line, so linking Xenon does not cost the user their status
//      bar. If they already had a statusline command, we run THEIRS and print its
//      output verbatim; otherwise we print our own compact line.
//
// This process sits in front of Claude Code's status bar, so it is written to be
// impossible to hang or break: every failure path falls through to printing
// something, and a hard timeout exits the process regardless of what is pending.
// It never throws, never blocks on the hub being up, and never writes to stderr
// in a way that would surface as an error to the user.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const STATE_FILE = path.join(__dirname, 'data', 'claude-bridge.json');
const POST_TIMEOUT_MS = 1500;   // the hub is on loopback; never wait longer
const CHAIN_TIMEOUT_MS = 3000;  // the user's own statusline gets a bit more room
const HARD_EXIT_MS = 4500;      // absolute ceiling for this process

// Never let this process outlive its usefulness: Claude Code re-runs it
// constantly, so a wedged instance must not accumulate.
const hardExit = setTimeout(() => process.exit(0), HARD_EXIT_MS);
if (typeof hardExit.unref === 'function') hardExit.unref();

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const s = JSON.parse(raw);
    return (s && typeof s === 'object') ? s : {};
  } catch { return {}; }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { buf += c; if (buf.length > 512 * 1024) finish(); });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch { finish(); }
    setTimeout(finish, 1200).unref?.();
  });
}

// Fire-and-forget POST. Resolves on completion OR timeout — the caller must not
// care which, because the status bar has to render either way.
function postToHub(body, state) {
  return new Promise((resolve) => {
    const port = Number(state.port) || 3030;
    const token = typeof state.token === 'string' ? state.token : '';
    if (!token) return resolve(false);

    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    try {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/claude/event',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Xenon-Bridge': token,
          'X-Xenon-Source': 'statusline',
        },
      }, (res) => { res.resume(); res.on('end', () => done(true)); });
      req.setTimeout(POST_TIMEOUT_MS, () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
      req.write(body);
      req.end();
    } catch { done(false); }
    setTimeout(() => done(false), POST_TIMEOUT_MS + 200).unref?.();
  });
}

// Run the statusline the user had before linking and return its stdout.
// NOTE ON `shell: true`: this string is not user INPUT being interpolated into a
// command — it IS a command, taken verbatim from the user's own settings.json,
// where Claude Code itself would have run it in a shell. Passing it through
// unchanged is the faithful behaviour; nothing is concatenated into it.
function runChained(command, stdinText) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const child = spawn(command, { shell: true, windowsHide: true });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => { out += c; if (out.length > 16 * 1024) child.kill(); });
      child.on('error', () => done(''));
      child.on('close', () => done(out.replace(/\s+$/, '')));
      const t = setTimeout(() => { try { child.kill(); } catch {} done(''); }, CHAIN_TIMEOUT_MS);
      if (typeof t.unref === 'function') t.unref();
      child.stdin.on('error', () => {});
      child.stdin.end(stdinText);
    } catch { done(''); }
  });
}

// ── our own default line ─────────────────────────────────────────────────────
function fmtPct(n) { return Math.round(n) + '%'; }
function fmtReset(epochSec) {
  const ms = (Number(epochSec) || 0) * 1000 - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60 ? String(m % 60).padStart(2, '0') : '');
  return Math.round(h / 24) + 'd';
}

function defaultLine(d) {
  const parts = [];
  const model = d.model && (d.model.display_name || d.model.id);
  if (model) parts.push(String(model));

  const ctx = d.context_window && d.context_window.used_percentage;
  if (typeof ctx === 'number') parts.push('ctx ' + fmtPct(ctx));

  const rl = d.rate_limits || {};
  const five = rl.five_hour && rl.five_hour.used_percentage;
  const seven = rl.seven_day && rl.seven_day.used_percentage;
  const lim = [];
  if (typeof five === 'number') {
    const r = fmtReset(rl.five_hour.resets_at);
    lim.push('5h ' + fmtPct(five) + (r ? ' ↻' + r : ''));
  }
  if (typeof seven === 'number') {
    const r = fmtReset(rl.seven_day.resets_at);
    lim.push('7d ' + fmtPct(seven) + (r ? ' ↻' + r : ''));
  }
  if (lim.length) parts.push(lim.join('  '));

  return parts.join('  ·  ') || 'xenon';
}

// ── main ─────────────────────────────────────────────────────────────────────
(async function main() {
  let raw = '';
  try { raw = await readStdin(); } catch { raw = ''; }

  const state = readState();
  let data = {};
  try { data = JSON.parse(raw) || {}; } catch { data = {}; }

  // Report to the hub and render the line concurrently: the status bar should
  // never wait on the POST, and the POST should never be skipped because the
  // chained command was slow.
  const chained = state.chained && typeof state.chained.command === 'string' ? state.chained.command : '';
  const [, chainedOut] = await Promise.all([
    raw ? postToHub(raw, state) : Promise.resolve(false),
    chained ? runChained(chained, raw) : Promise.resolve(null),
  ]);

  const line = (chainedOut != null && chainedOut !== '') ? chainedOut : defaultLine(data);
  process.stdout.write(line + '\n');
  process.exit(0);
})().catch(() => { try { process.stdout.write('xenon\n'); } catch {} process.exit(0); });
