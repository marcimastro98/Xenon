'use strict';

// Runs Claude Code from the dashboard.
//
// This is the one place in Xenon that starts a coding agent on the user's
// machine, so the boundaries matter more than the feature:
//
//  - NEVER a shell. `claude` is a real executable and is spawned with an argv
//    array, so a prompt containing quotes, semicolons or backticks is one
//    argument and cannot become syntax. See the spawn invariant in CLAUDE.md.
//  - NEVER a path from the wire. The caller picks a project by ID from
//    listProjects(); the directory itself comes from Claude Code's own
//    transcripts, which is to say from places the user already works in. The
//    same shape as the Slideshow folder source: enumerate server-side, address
//    by index.
//  - NEVER a permission bypass. Runs start in Claude Code's normal permission
//    mode, so every tool call goes through the PermissionRequest hook and comes
//    back to the touchscreen as an approval card. `bypassPermissions` and
//    `--dangerously-skip-permissions` are deliberately not options here, not
//    even behind a setting: a button that silently grants an agent write access
//    to the disk is not a feature this dashboard should own.
//
// Runs are in-memory and per-boot, like the bridge. Nothing here writes to disk.

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const MAX_PROMPT = 4000;          // one touchscreen dictation, generously
const MAX_RUNS = 2;               // concurrent; the quota is shared and finite
const MAX_OUTPUT_CHARS = 24000;   // per run, oldest text dropped first
const MAX_PROJECTS = 40;
const RUN_TTL_MS = 30 * 60 * 1000;
const PROJECT_TTL_MS = 60 * 1000; // project list cache
const HEAD_BYTES = 65536;         // how much of a transcript we read to find cwd
const START_TIMEOUT_MS = 20 * 60 * 1000;

// Control characters are stripped rather than escaped. Nothing here is a shell
// argument (there is no shell), but a stray escape sequence out of a transcript
// or a stderr line would corrupt the tile layout. Tab and newline survive: a
// dictated prompt legitimately contains them.
function str(v, max) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) {
    const n = ch.charCodeAt(0);
    if ((n < 32 && n !== 9 && n !== 10) || (n >= 127 && n < 160)) continue;
    out += ch;
  }
  const s = out.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function projectId(dir) {
  return crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 12);
}

// ── locating the claude executable ───────────────────────────────────────────
// The native installer drops a real .exe, which spawns cleanly with an argv
// array. An npm install instead leaves a .cmd shim on Windows, and running THAT
// would need a shell — so rather than relax the invariant we resolve the shim's
// underlying cli.js and run it through node, which stays argv-clean.
let execCache = null;

async function isFile(p) {
  try { return (await fsp.stat(p)).isFile(); } catch { return false; }
}

function whichRaw(name) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, [name], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    });
  });
}

async function resolveExecutable() {
  if (execCache) return execCache;
  const win = process.platform === 'win32';
  const home = os.homedir();

  // 1. The native installer's location, by far the common case.
  const native = path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude');
  if (await isFile(native)) return (execCache = { cmd: native, pre: [] });

  // 2. Whatever is on PATH.
  for (const hit of await whichRaw('claude')) {
    const low = hit.toLowerCase();
    if (win ? low.endsWith('.exe') : !low.endsWith('.cmd') && !low.endsWith('.ps1')) {
      return (execCache = { cmd: hit, pre: [] });
    }
    // 3. An npm shim: find the package entry next to it and run it under node.
    const cli = path.join(path.dirname(hit), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (await isFile(cli)) return (execCache = { cmd: process.execPath, pre: [cli] });
  }
  return null;
}

// ── the project allowlist ────────────────────────────────────────────────────
// Claude Code stores transcripts at <config>/projects/<encoded-cwd>/<uuid>.jsonl.
// The directory name is a lossy encoding of the path (separators and literal
// dashes both become "-"), so it cannot be decoded back reliably. The exact cwd
// is inside the transcript, so we read it from there and then confirm the
// directory still exists — a project that has been moved or deleted must not
// appear as somewhere Xenon can start work.
async function readCwdFromTranscript(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const text = buf.slice(0, bytesRead).toString('utf8');
    // The tail line is very likely truncated; drop it rather than parse garbage.
    const lines = text.split('\n');
    if (bytesRead === HEAD_BYTES) lines.pop();
    for (const line of lines) {
      if (!line || line.indexOf('"cwd"') === -1) continue;
      try {
        const cwd = JSON.parse(line).cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch { /* partial or non-JSON line */ }
    }
  } catch { /* unreadable transcript */ } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return '';
}

async function newestTranscript(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return ''; }
  let best = '';
  let bestAt = -1;
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, ent.name);
    try {
      const st = await fsp.stat(full);
      if (st.mtimeMs > bestAt) { bestAt = st.mtimeMs; best = full; }
    } catch { /* vanished mid-scan */ }
  }
  return best;
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

function createRunner(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const onChange = typeof o.onChange === 'function' ? o.onChange : () => {};
  const projectsDirOf = typeof o.projectsDir === 'function' ? o.projectsDir : () => '';

  const runs = new Map();     // id -> record
  let seq = 0;
  let projectCache = { at: 0, list: [] };
  let emitScheduled = false;

  function emit() {
    if (emitScheduled) return;
    emitScheduled = true;
    setImmediate(() => { emitScheduled = false; try { onChange(); } catch { /* never let a listener break a run */ } });
  }

  async function listProjects(force) {
    const t = now();
    if (!force && projectCache.list.length && (t - projectCache.at) < PROJECT_TTL_MS) return projectCache.list;

    const root = projectsDirOf();
    const out = [];
    if (root) {
      let entries = [];
      try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { entries = []; }
      const dirs = entries.filter(e => e.isDirectory()).slice(0, MAX_PROJECTS * 3);
      const seen = new Set();
      for (const ent of dirs) {
        const transcript = await newestTranscript(path.join(root, ent.name));
        if (!transcript) continue;
        const cwd = await readCwdFromTranscript(transcript);
        if (!cwd) continue;
        const key = cwd.toLowerCase();
        if (seen.has(key)) continue;
        if (!(await isDir(cwd))) continue;      // moved or deleted → not offerable
        seen.add(key);
        let lastAt = 0;
        try { lastAt = (await fsp.stat(transcript)).mtimeMs; } catch { /* keep 0 */ }
        out.push({ id: projectId(cwd), name: path.basename(cwd) || cwd, path: cwd, lastAt });
        if (out.length >= MAX_PROJECTS) break;
      }
    }
    out.sort((a, b) => b.lastAt - a.lastAt);     // most recently worked in first
    projectCache = { at: t, list: out };
    return out;
  }

  function activeCount() {
    let n = 0;
    for (const r of runs.values()) if (r.state === 'running') n++;
    return n;
  }

  function appendOut(rec, text) {
    if (!text) return;
    rec.output += text;
    if (rec.output.length > MAX_OUTPUT_CHARS) rec.output = rec.output.slice(-MAX_OUTPUT_CHARS);
  }

  // Best-effort reading of the stream-json event feed. The shapes are Claude
  // Code's, not ours, so anything unrecognised is ignored rather than guessed
  // at — except the final `result`, which is the authoritative answer and is
  // what the tile shows if nothing else parsed.
  function consumeEvent(rec, ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
      rec.sessionId = str(ev.session_id, 80);
      return;
    }
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') appendOut(rec, block.text);
      }
      return;
    }
    if (ev.type === 'result') {
      if (typeof ev.session_id === 'string') rec.sessionId = str(ev.session_id, 80);
      if (typeof ev.result === 'string' && ev.result.trim()) { rec.output = ''; appendOut(rec, ev.result); }
      if (typeof ev.total_cost_usd === 'number') rec.costUsd = ev.total_cost_usd;
      if (ev.is_error === true) rec.error = rec.error || 'run_error';
    }
  }

  function settle(rec, state, error) {
    if (rec.state !== 'running') return;
    rec.state = state;
    if (error) rec.error = error;
    rec.endedAt = now();
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    rec.child = null;
    emit();
  }

  async function start(input) {
    const i = input && typeof input === 'object' ? input : {};
    const prompt = str(i.prompt, MAX_PROMPT);
    if (!prompt) return { ok: false, error: 'empty_prompt' };
    if (activeCount() >= MAX_RUNS) return { ok: false, error: 'too_many_runs' };

    // Resume targets a session by id, which Claude Code looks up relative to the
    // project directory — so a resume still needs, and still validates, a
    // project from the allowlist.
    const resume = str(i.resume, 80);
    if (resume && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(resume)) return { ok: false, error: 'bad_session' };

    const projects = await listProjects();
    const proj = projects.find(p => p.id === str(i.projectId, 40));
    if (!proj) return { ok: false, error: 'unknown_project' };

    const exe = await resolveExecutable();
    if (!exe) return { ok: false, error: 'claude_not_found' };

    const model = str(i.model, 40);
    if (model && !/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(model)) return { ok: false, error: 'bad_model' };

    const args = exe.pre.slice();
    if (resume) args.push('--resume', resume);
    args.push('-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages');
    if (model) args.push('--model', model);

    let child;
    try {
      child = spawn(exe.cmd, args, {
        cwd: proj.path,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return { ok: false, error: 'spawn_failed' };
    }

    const id = 'r' + (++seq) + '-' + now().toString(36);
    const rec = {
      id,
      projectId: proj.id,
      project: proj.name,
      prompt,
      model,
      sessionId: resume || '',
      resumed: !!resume,
      state: 'running',
      output: '',
      error: '',
      costUsd: 0,
      startedAt: now(),
      endedAt: 0,
      child,
      timer: null,
      buf: '',
    };
    runs.set(id, rec);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      rec.buf += chunk;
      // Never let an unterminated line grow without bound.
      if (rec.buf.length > MAX_OUTPUT_CHARS * 2) rec.buf = rec.buf.slice(-MAX_OUTPUT_CHARS);
      const lines = rec.buf.split('\n');
      rec.buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        try { consumeEvent(rec, JSON.parse(s)); } catch { /* not an event line */ }
      }
      emit();
    });
    // stderr is diagnostic only: a run that fails must say something, but its
    // stderr must never be mistaken for Claude's answer.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (!rec.error) rec.error = str(chunk, 240);
    });

    child.on('error', () => settle(rec, 'failed', 'spawn_failed'));
    child.on('close', (code) => {
      if (rec.stopping) return settle(rec, 'stopped');
      settle(rec, code === 0 ? 'done' : 'failed', code === 0 ? '' : (rec.error || 'exit_' + code));
    });

    rec.timer = setTimeout(() => { rec.stopping = true; try { child.kill(); } catch { /* already gone */ } }, START_TIMEOUT_MS);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();

    emit();
    return { ok: true, id, project: proj.name };
  }

  function stop(id) {
    const rec = runs.get(str(id, 60));
    if (!rec || rec.state !== 'running' || !rec.child) return false;
    rec.stopping = true;
    // SIGTERM is the documented way to end a `claude -p` run: it aborts the turn,
    // tears down the process tree of any command it was running, and lets the
    // session-end hooks fire. On Windows kill() maps to a hard terminate, which
    // is the only option there.
    try { rec.child.kill('SIGTERM'); } catch { return false; }
    return true;
  }

  function stopAll() {
    for (const rec of runs.values()) {
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
      if (rec.state === 'running' && rec.child) {
        rec.stopping = true;
        try { rec.child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    }
  }

  function sweep() {
    const t = now();
    for (const [id, rec] of runs) {
      if (rec.state !== 'running' && rec.endedAt && (t - rec.endedAt) > RUN_TTL_MS) runs.delete(id);
    }
  }

  function snapshot() {
    sweep();
    const t = now();
    return Array.from(runs.values())
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(r => ({
        id: r.id,
        project: r.project,
        projectId: r.projectId,
        prompt: r.prompt,
        model: r.model,
        sessionId: r.sessionId,
        resumed: r.resumed,
        state: r.state,
        output: r.output,
        error: r.state === 'failed' ? r.error : '',
        costUsd: r.costUsd,
        elapsedMs: (r.endedAt || t) - r.startedAt,
      }));
  }

  return { listProjects, start, stop, stopAll, snapshot, _runs: runs };
}

module.exports = {
  createRunner,
  MAX_PROMPT,
  MAX_RUNS,
  // exposed for unit tests
  _internal: { str, projectId, readCwdFromTranscript, resolveExecutable },
};
