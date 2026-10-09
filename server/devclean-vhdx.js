'use strict';

// WSL and Docker Desktop virtual disks (Windows only). A .vhdx grows as Linux
// writes and never shrinks by itself, so after a big prune inside Docker the
// file on C: stays just as large. Detection is read-only (filesystem + reg.exe);
// compaction runs compact-vhdx.ps1, which raises its own UAC prompt and
// re-validates the disk before touching it.

const fsp = require('fs').promises;
const path = require('path');
const { stableId } = require('./devclean-ids.js');
const os = require('os');

const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';
const STATUS_FILE = 'xenon-devclean-compact.json';
const TERMINAL = new Set(['done', 'error', 'declined']);
const POLL_MS = 2000;
const COMPACT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
// A disk this small has nothing worth a UAC prompt and a Docker restart.
const MIN_OFFER_BYTES = 10 * 1024 ** 3;

// `reg query <key> /s /v BasePath` → [{ name, basePath }]. Each subkey block
// starts with the key path; DistributionName is read in the same pass.
function parseLxss(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) { cur = { name: '', basePath: '' }; out.push(cur); continue; }
    const m = /^\s+(BasePath|DistributionName)\s+REG_\w+\s+(.+?)\s*$/i.exec(line);
    if (m && cur) cur[m[1].toLowerCase() === 'basepath' ? 'basePath' : 'name'] = m[2].replace(/^\\\\\?\\/, '');
  }
  return out.filter((d) => d.basePath);
}

async function findVhdx(dir, depth = 3) {
  const found = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) found.push(...await findVhdx(p, depth - 1));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.vhdx')) found.push(p);
  }
  return found;
}

function createVhdxSource({ run, platform = process.platform, env = process.env, scriptPath, spawnDetached, onProgress, getDockerUsed }) {
  let ids = new Map(); // opaque id -> absolute .vhdx path
  let job = null;      // { id, state, before, after, error, startedAt }
  let pollTimer = null;
  const statusPath = path.join(os.tmpdir(), STATUS_FILE);

  async function listDisks() {
    const disks = [];
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const p of await findVhdx(path.join(localAppData, 'Docker', 'wsl'))) disks.push({ kind: 'docker', name: 'Docker Desktop', file: p });
    try {
      const { stdout } = await run('reg', ['query', LXSS_KEY, '/s'], { timeout: 10000 });
      for (const d of parseLxss(stdout)) {
        const file = path.join(d.basePath, 'ext4.vhdx');
        if (!disks.some((x) => x.file.toLowerCase() === file.toLowerCase())) disks.push({ kind: 'wsl', name: d.name || 'WSL', file });
      }
    } catch { /* no WSL distros registered */ }
    const sized = [];
    for (const d of disks) {
      try { sized.push({ ...d, bytes: (await fsp.stat(d.file)).size }); } catch { /* listed but gone */ }
    }
    return sized;
  }

  async function overview() {
    if (platform !== 'win32') return { available: false, reason: 'windows_only' };
    const disks = await listDisks();
    if (!disks.length) return { available: false, reason: 'not_installed' };
    // Docker's own figure is the one honest "used" number we can get without
    // booting a WSL distro just to ask it (which would cost the RAM we save).
    const dockerUsed = await Promise.resolve(getDockerUsed && getDockerUsed()).catch(() => null);
    ids = new Map();
    const items = disks.sort((a, b) => b.bytes - a.bytes).map((d) => {
      const id = stableId('v', d.file.toLowerCase());
      ids.set(id, d.file);
      const used = d.kind === 'docker' && Number.isFinite(dockerUsed) && /docker_data/i.test(d.file) ? dockerUsed : null;
      return {
        id, kind: d.kind, name: d.name, file: path.basename(d.file), bytes: d.bytes,
        used, reclaimable: used == null ? null : Math.max(0, d.bytes - used),
        offer: d.bytes >= MIN_OFFER_BYTES,
      };
    });
    return {
      available: true,
      bytes: items.reduce((n, it) => n + it.bytes, 0),
      reclaimable: items.reduce((n, it) => n + (it.reclaimable || 0), 0),
      items,
      job: jobSnapshot(),
    };
  }

  function jobSnapshot() { return job ? { ...job } : null; }

  async function poll() {
    pollTimer = null;
    if (!job) return;
    let st = null;
    try { st = JSON.parse((await fsp.readFile(statusPath, 'utf8')).replace(/^\uFEFF/, '')); } catch { /* not written yet */ }
    if (st && typeof st.state === 'string') {
      job = { ...job, state: st.state, before: st.before ?? job.before, after: st.after ?? null, error: st.error || null };
    }
    if (!TERMINAL.has(job.state) && Date.now() - job.startedAt > COMPACT_TIMEOUT_MS) job = { ...job, state: 'error', error: 'timeout' };
    if (onProgress) onProgress(jobSnapshot());
    if (!TERMINAL.has(job.state)) pollTimer = setTimeout(poll, POLL_MS);
  }

  async function compact(id) {
    if (platform !== 'win32') return { ok: false, error: 'windows_only' };
    if (job && !TERMINAL.has(job.state)) return { ok: false, error: 'busy' };
    const file = ids.get(id);
    if (!file) return { ok: false, error: 'bad_item' };
    await fsp.rm(statusPath, { force: true });
    const psExe = path.join(env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      spawnDetached(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Vhdx', file, '-Status', statusPath]);
    } catch {
      return { ok: false, error: 'spawn' };
    }
    job = { id, state: 'prompt', before: null, after: null, error: null, startedAt: Date.now() };
    if (onProgress) onProgress(jobSnapshot());
    pollTimer = setTimeout(poll, POLL_MS);
    return { ok: true, job: jobSnapshot() };
  }

  // Stops watching; the elevated child is not ours to kill (and killing diskpart
  // mid-compact is exactly what must not happen).
  function stop() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }

  return { overview, compact, job: jobSnapshot, stop };
}

module.exports = { createVhdxSource, parseLxss, MIN_OFFER_BYTES };
