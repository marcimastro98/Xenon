'use strict';

// ── Claude Code live session registry ────────────────────────────────────────
// Every running `claude` process writes its own state to
// <configDir>/sessions/<pid>.json and keeps it current:
//
//   {"pid":4020,"sessionId":"6fe1314f-…","cwd":"C:\\…\\xenon","startedAt":…,
//    "version":"2.1.220","kind":"interactive","entrypoint":"cli",
//    "name":"xenon-ef","nameSource":"derived","status":"busy","updatedAt":…}
//
// The hub already learns most of this from hooks, so why read it at all? Because
// hooks only tell you about a session that spoke to you. Two things they cannot
// say, and both were visible bugs:
//
//   • a session that started BEFORE Xenon did, or before Claude Code was linked,
//     is invisible until it happens to fire a hook. The registry lists it now.
//   • a session killed with Ctrl-C, or whose terminal was closed, fires no
//     SessionEnd. The bridge kept it in the live list for a full hour. Its pid is
//     right here, so "is this still running" is a question with a real answer.
//
// THE RULE, identical to the Living Index's: this is a CACHE OF THE FILESYSTEM,
// never an authority. It corroborates the hook feed; it never overrides it, and
// nothing here is on a path that must work. If the directory is absent, the
// format changes, or every read fails, the bridge degrades to exactly the
// behaviour it had before this file existed. That is why `parseRegistryFile` is
// pure and fixture-tested: it is the only part of this testable off a machine
// with live Claude Code sessions.
//
// Nothing here is ever HTTP-served as-is. `cwd` in particular stays server-side,
// the same rule the bridge's own snapshot follows.

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

// A registry file whose process is gone but which nobody cleaned up. Claude Code
// removes its own file on a clean exit, so anything left behind is a crash or a
// kill — we still verify the pid rather than trusting the age alone, because a
// long silent session (a 20-minute build) is not a dead one.
const STALE_FILE_MS = 24 * 60 * 60 * 1000;
const MAX_FILES = 64;         // bounds a directory nobody prunes
const MAX_STR = 220;

function str(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  const cap = max || MAX_STR;
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Claude Code honors CLAUDE_CONFIG_DIR; otherwise ~/.claude. Same resolution as
// claude-usage.js — one answer to "where does Claude Code keep its state", not
// two that can disagree.
function resolveSessionsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR && String(process.env.CLAUDE_CONFIG_DIR).trim();
  const root = base || path.join(os.homedir(), '.claude');
  return path.join(root, 'sessions');
}

// PURE. Text of one <pid>.json → a normalized record, or null when there is
// nothing usable in it. Never throws: a half-written file (the process is
// writing it as we read) is a miss, not a failure.
function parseRegistryFile(text) {
  let d = null;
  try { d = JSON.parse(String(text || '')); } catch { return null; }
  if (!d || typeof d !== 'object') return null;

  const sessionId = str(d.sessionId, 80);
  if (!sessionId) return null;                 // without an id it joins nothing

  const pid = num(d.pid);
  // `status` is what a live interactive session reports; background agents in
  // `claude agents --json` use `state` instead. Two vocabularies for one thing,
  // folded here so every caller sees one.
  const raw = str(d.status || d.state, 40).toLowerCase();
  let status = 'idle';
  if (raw === 'busy' || raw === 'running' || raw === 'working') status = 'busy';
  else if (raw === 'blocked' || raw === 'waiting') status = 'blocked';

  return {
    sessionId,
    pid: pid === null ? null : Math.trunc(pid),
    cwd: str(d.cwd, 400),
    name: str(d.name, 80),
    // A name Claude Code derived from the folder ("xenon-ef") is not a name the
    // user chose; the widget shows a chosen one and hides a derived one behind
    // the project it already displays.
    nameDerived: str(d.nameSource, 40) === 'derived',
    kind: str(d.kind, 30) || 'interactive',
    entrypoint: str(d.entrypoint, 30),
    version: str(d.version, 30),
    startedAt: num(d.startedAt),
    updatedAt: num(d.updatedAt),
    status,
  };
}

// Is this pid one of ours-that-is-actually-alive? signal 0 does not deliver
// anything, it only asks. EPERM means the process exists and belongs to somebody
// else, which for our purposes is still "exists" — we err toward keeping a
// session rather than declaring a live one dead.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return !!(err && err.code === 'EPERM'); }
}

// Read the whole registry. Returns [] for every failure mode — an absent
// directory (Claude Code not installed, or too old to write one), a permission
// error, garbage inside. The caller cannot tell those apart and must not need
// to: no registry simply means no corroboration.
async function readRegistry(opts) {
  const options = opts || {};
  const dir = options.dir || resolveSessionsDir();
  const alive = typeof options.pidAlive === 'function' ? options.pidAlive : pidAlive;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch { return []; }
  if (!names.length) return [];

  // Newest first, so a directory nobody pruned loses its oldest entries rather
  // than an arbitrary slice.
  const stated = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try { stated.push({ full, mtime: (await fs.stat(full)).mtimeMs }); }
    catch { /* vanished between readdir and stat: the normal race, not an error */ }
  }
  stated.sort((a, b) => b.mtime - a.mtime);

  const out = [];
  const t = now();
  for (const { full, mtime } of stated.slice(0, MAX_FILES)) {
    if (t - mtime > STALE_FILE_MS) continue;
    let text = '';
    try { text = await fs.readFile(full, 'utf8'); } catch { continue; }
    const rec = parseRegistryFile(text);
    if (!rec) continue;
    // The pid is the whole reason this file is worth reading. A record whose
    // process is gone is reported as such rather than dropped, so the bridge can
    // retire its own copy of that session instead of waiting an hour for it to
    // go stale.
    rec.alive = rec.pid === null ? true : alive(rec.pid);
    out.push(rec);
  }
  return out;
}

module.exports = { readRegistry, parseRegistryFile, pidAlive, resolveSessionsDir, STALE_FILE_MS, MAX_FILES };
