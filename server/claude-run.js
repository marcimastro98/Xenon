'use strict';

// Runs Claude Code from the dashboard.
//
// This is the one place in Xenon that starts a coding agent on the user's
// machine, so the boundaries matter more than the feature:
//
//  - NEVER a shell. `claude` is a real executable and is spawned with an argv
//    array, so a prompt containing quotes, semicolons or backticks is one
//    argument and cannot become syntax. See the spawn invariant in CLAUDE.md.
//  - NEVER a path from the wire into a run. The caller picks a project by ID
//    from listProjects(); the directory itself comes from Claude Code's own
//    transcripts (places the user already works in) or from a folder the user
//    added with addFolder(). That one takes a path, but only to validate it
//    (absolute, an existing directory, not a drive root) and keep it in the
//    list: the run itself still goes by id, and the endpoint is loopback-only.
//  - NEVER a permission bypass. A run starts in the user's own default mode,
//    or in one of RUN_MODES picked on the tile: `manual` (ask for everything),
//    `acceptEdits` or `plan`. Whatever still needs a person goes through the
//    PermissionRequest hook and comes back to the touchscreen as an approval
//    card. `bypassPermissions`, `dontAsk` and `--dangerously-skip-permissions`
//    are deliberately not options here, not even behind a setting: a button
//    that silently grants an agent write access to the disk is not a feature
//    this dashboard should own.
//
// Runs are in-memory and per-boot, like the bridge. Nothing here writes to disk.

const { spawn } = require('child_process');
require('./atomic-write');

const {
  MAX_PROMPT, MAX_RUNS, MAX_OUTPUT_CHARS, RUN_TTL_MS, START_TIMEOUT_MS, EFFORTS,
} = require('./claude-code/run-limits.js');
const { readCwdFromTranscript } = require('./claude-code/run-project-folder.js');
const { str, projectId, toolDetail } = require('./claude-code/run-text.js');

const { runCaches } = require('./claude-code/run-caches.js');

const {
  RUN_MODES, whichRaw, resolveExecutable, parseOptions, cliOptions,
} = require('./claude-code/run-executable.js');

const { makeProjects } = require('./claude-code/run-projects.js');

const { makeEvents } = require('./claude-code/run-events.js');

function createRunner(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const onChange = typeof o.onChange === 'function' ? o.onChange : () => {};
  const projectsDirOf = typeof o.projectsDir === 'function' ? o.projectsDir : () => '';
  const foldersFile = typeof o.foldersFile === 'string' ? o.foldersFile : '';
  const held = {
    extraFolders: null,    // [{ path, at }] added by hand, loaded on first use
    seq: 0,
    projectCache: { at: 0, list: [] },
    emitScheduled: false,
  };

  const runs = new Map();     // id -> record

  function emit() {
    if (held.emitScheduled) return;
    held.emitScheduled = true;
    setImmediate(() => { held.emitScheduled = false; try { onChange(); } catch { /* never let a listener break a run */ } });
  }

  const { addFolder, listProjects } = makeProjects({ now, projectsDirOf, foldersFile, held });

  function activeCount() {
    let n = 0;
    for (const r of runs.values()) if (r.state === 'running') n++;
    return n;
  }

  const { consumeEvent } = makeEvents({ now });

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

    const model = str(i.model, 40);
    if (model && !/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(model)) return { ok: false, error: 'bad_model' };
    // Both are checked against fixed lists before they get near argv, and
    // dropped (not refused) when this Claude Code does not know them.
    const mode = str(i.mode, 20);
    if (mode && !RUN_MODES.includes(mode)) return { ok: false, error: 'bad_mode' };
    const effort = str(i.effort, 10);
    if (effort && !EFFORTS.includes(effort)) return { ok: false, error: 'bad_effort' };
    // Only now look for Claude Code (a PATH probe): bad input never starts a process.
    const exe = await resolveExecutable();
    if (!exe) return { ok: false, error: 'claude_not_found' };
    const cli = (mode || effort) ? await cliOptions() : { effort: false, modes: [] };
    const useMode = mode && cli.modes.includes(mode) ? mode : '';
    const useEffort = effort && cli.effort ? effort : '';

    const args = exe.pre.slice();
    if (resume) args.push('--resume', resume);
    args.push('-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages');
    if (model) args.push('--model', model);
    if (useMode) args.push('--permission-mode', useMode);
    if (useEffort) args.push('--effort', useEffort);

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

    const id = 'r' + (++held.seq) + '-' + now().toString(36);
    const rec = {
      id,
      projectId: proj.id,
      project: proj.name,
      prompt,
      model,
      mode: useMode,
      effort: useEffort,
      activity: [],
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

  function openCall(rec) {
    for (let k = rec.activity.length - 1; k >= 0; k--) if (rec.activity[k].ok === null) return rec.activity[k];
    return {};
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
        mode: r.mode,
        effort: r.effort,
        // The call still running, if any, and the last few with their outcome.
        tool: r.state === 'running' ? (openCall(r).tool || '') : '',
        toolDetail: r.state === 'running' ? (openCall(r).detail || '') : '',
        activity: r.activity.filter((a) => a.ok !== null).slice(-4)
          .map((a) => ({ tool: a.tool, detail: a.detail, ok: a.ok, ms: a.ms })),
        sessionId: r.sessionId,
        resumed: r.resumed,
        state: r.state,
        output: r.output,
        error: r.state === 'failed' ? r.error : '',
        costUsd: r.costUsd,
        elapsedMs: (r.endedAt || t) - r.startedAt,
      }));
  }

  return { listProjects, addFolder, start, stop, stopAll, snapshot, _runs: runs };
}

module.exports = {
  createRunner,
  MAX_PROMPT,
  MAX_RUNS,
  RUN_MODES,
  EFFORTS,
  cliOptions,
  // Shared with ai-cli.js (the Claude Code chat provider), so there is one
  // answer to "where is claude" and one PATH probe.
  resolveExecutable,
  whichRaw,
  // exposed for unit tests
  _internal: { str, projectId, readCwdFromTranscript, resolveExecutable, toolDetail, parseOptions,
    setOptions: (o) => { runCaches.options = o; } },
};
