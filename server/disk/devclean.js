'use strict';

// Dev cleanup: the developer-tool space the Disk widget's closed categories do
// not cover (Docker, Ollama models, stale editor workspace storage, WSL/Docker
// virtual disks). Supporter-only; the gate is checked by the routes in
// server.js, not here.
//
// Same contract as the Disk widget: the dashboard gets opaque item ids minted
// here and sends back only `source + ids`. Nothing is read until the tile asks
// (no timers), one cleanup runs at a time, and every source re-checks its own
// item right before acting.

const { createDockerSource } = require('./devclean-docker.js');
const { createOllamaSource } = require('./devclean-ollama.js');
const { createVscodeSource } = require('./devclean-vscode.js');
const { createVhdxSource } = require('./devclean-vhdx.js');
const { ID_RE } = require('./devclean-ids.js');

const RUNNABLE = ['docker', 'ollama', 'vscode'];
const DOCKER_IDS = ['images', 'buildCache'];
const OVERVIEW_TTL_MS = 15 * 1000;

function createDevClean({ run, getSettings, trash, scriptPath, spawnDetached, onProgress }) {
  const docker = createDockerSource({ run });
  const sources = {
    docker,
    ollama: createOllamaSource({ getSettings }),
    vscode: createVscodeSource({ trash }),
  };
  let lastDocker = null;
  const vhdx = createVhdxSource({
    run, scriptPath, spawnDetached,
    onProgress: (job) => onProgress && onProgress({ kind: 'compact', job }),
    getDockerUsed: () => (lastDocker && lastDocker.available ? lastDocker.bytes : null),
  });

  let cached = null;   // { at, data }
  let building = null;
  let runJob = null;   // { source, state, freed, failed }

  async function build() {
    const safe = (p) => p.catch(() => ({ available: false, reason: 'error' }));
    const [d, o, v] = await Promise.all([safe(docker.overview()), safe(sources.ollama.overview()), safe(sources.vscode.overview())]);
    lastDocker = d;
    const disks = await safe(vhdx.overview());
    const data = { docker: d, ollama: o, vscode: v, vhdx: disks };
    data.reclaimable = Object.values(data).reduce((n, s) => n + ((s && s.reclaimable) || 0), 0);
    cached = { at: Date.now(), data };
    return data;
  }

  async function overview({ refresh = false } = {}) {
    if (!refresh && cached && Date.now() - cached.at < OVERVIEW_TTL_MS) return { ...cached.data, job: runJob };
    if (!building) building = build().finally(() => { building = null; });
    return { ...(await building), job: runJob };
  }

  async function runClean(source, ids) {
    if (!RUNNABLE.includes(source)) return { ok: false, error: 'bad_source' };
    const list = (Array.isArray(ids) ? ids : [])
      .filter((id) => typeof id === 'string' && (ID_RE.test(id) || DOCKER_IDS.includes(id)))
      .slice(0, 500);
    if (!list.length) return { ok: false, error: 'empty' };
    if (runJob && runJob.state === 'running') return { ok: false, error: 'busy' };
    runJob = { source, state: 'running', freed: 0, failed: [] };
    if (onProgress) onProgress({ kind: 'run', job: runJob });
    // Detached from the request: a prune can take minutes. The tile follows it
    // over SSE and re-attaches through /api/devclean/overview after a reload.
    Promise.resolve()
      .then(() => sources[source].clean(list))
      .then((res) => { runJob = { source, state: 'done', freed: res.freed || 0, failed: res.failed || [] }; })
      .catch(() => { runJob = { source, state: 'done', freed: 0, failed: list }; })
      .finally(() => { cached = null; if (onProgress) onProgress({ kind: 'run', job: runJob }); });
    return { ok: true, job: runJob };
  }

  async function compact(id) {
    // Resolved against the ids of the overview the tile is showing; rebuilding
    // first could re-mint them under the user's finger.
    const res = await vhdx.compact(String(id || ''));
    cached = null;
    return res;
  }

  // The SDK `devStorage` stream: numbers only. No model names, project names or
  // paths, so a community widget learns how much space, never what is on disk.
  async function summary() {
    const o = await overview();
    const pick = (s, extra) => (s && s.available
      ? { available: true, bytes: s.bytes || 0, reclaimable: s.reclaimable || 0, ...extra(s) }
      : { available: false, bytes: 0, reclaimable: 0 });
    return {
      docker: pick(o.docker, () => ({})),
      ollama: pick(o.ollama, (s) => ({ count: s.items.length })),
      vscode: pick(o.vscode, (s) => ({ stale: s.items.length })),
      vhdx: pick(o.vhdx, (s) => ({ count: s.items.length })),
      reclaimable: o.reclaimable || 0,
    };
  }

  function stop() { vhdx.stop(); }

  return { overview, runClean, compact, compactJob: vhdx.job, summary, stop };
}

module.exports = { createDevClean, RUNNABLE };
