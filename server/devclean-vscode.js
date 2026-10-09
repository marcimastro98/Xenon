'use strict';

// VS Code-family `workspaceStorage`: one folder per project ever opened, kept
// forever. A folder is stale when its workspace.json points at a local folder or
// .code-workspace file that no longer exists. Remote workspaces (WSL, SSH,
// containers) and folders without a workspace.json are never stale: we cannot
// prove their project is gone. Removal goes to the Recycle Bin/Trash through the
// Disk widget's guarded delete.

const fsp = require('fs').promises;
const path = require('path');
const { stableId } = require('./devclean-ids.js');
const os = require('os');
const { fileURLToPath } = require('url');

const EDITORS = ['Code', 'Code - Insiders', 'Cursor', 'VSCodium'];
const SIZE_WALK_CAP = 20000; // entries per folder; past it the size is a floor

// Where each editor keeps its user data, per OS.
function storageRoots({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const base = platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return EDITORS.map((editor) => ({ editor, dir: path.join(base, editor, 'User', 'workspaceStorage') }));
}

// The target a workspace.json names, as a local path, or null when it is not a
// local file URI (remote, untitled, malformed) and so can never be judged stale.
function workspaceTarget(json) {
  const uri = json && (json.folder || json.workspace);
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try { return fileURLToPath(uri); } catch { return null; }
}

async function exists(p) {
  try { await fsp.stat(p); return true; } catch (e) { return e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR'; }
}

// A project on a drive that is simply unplugged right now (F:, /Volumes/USB,
// /media/x) or on a network share is not gone: only a missing target on a
// mounted local volume counts.
async function isStale(target) {
  if (target.startsWith('\\\\')) return false;
  const mount = /^(\/(?:Volumes|media|mnt|run\/media)\/[^/]+(?:\/[^/]+)?)/.exec(target);
  const volume = mount ? mount[1] : path.parse(target).root;
  if (!(await exists(volume))) return false;
  return !(await exists(target));
}

async function dirSize(root) {
  let total = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length && seen < SIZE_WALK_CAP) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > SIZE_WALK_CAP) break;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += (await fsp.lstat(p)).size; } catch { /* vanished */ } }
    }
  }
  return total;
}

function createVscodeSource({ trash, roots = storageRoots() }) {
  let ids = new Map(); // opaque id -> { root, dir }

  async function overview() {
    const found = [];
    for (const { editor, dir } of roots) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const folder = path.join(dir, e.name);
        let json = null;
        try { json = JSON.parse(await fsp.readFile(path.join(folder, 'workspace.json'), 'utf8')); } catch { /* none */ }
        const target = workspaceTarget(json);
        const stale = target ? await isStale(target) : false;
        found.push({ editor, root: dir, folder, target, stale, bytes: await dirSize(folder) });
      }
    }
    if (!found.length && !(await Promise.all(roots.map((r) => exists(r.dir)))).some(Boolean)) {
      return { available: false, reason: 'not_installed' };
    }
    ids = new Map();
    const items = found
      .filter((f) => f.stale)
      .sort((a, b) => b.bytes - a.bytes)
      .map((f) => {
        const id = stableId('w', f.folder);
        ids.set(id, { root: f.root, dir: f.folder });
        // The project name only (its last segment): enough to recognise it,
        // without sending the whole path to the dashboard.
        return { id, kind: 'workspace', editor: f.editor, name: path.basename(f.target), bytes: f.bytes };
      });
    return {
      available: true,
      bytes: found.reduce((n, f) => n + f.bytes, 0),
      reclaimable: items.reduce((n, it) => n + it.bytes, 0),
      items,
      kept: { workspaces: found.length - items.length },
    };
  }

  async function clean(selected) {
    const byRoot = new Map();
    const failed = [];
    for (const id of selected) {
      const hit = ids.get(id);
      if (!hit) { failed.push(id); continue; }
      if (!byRoot.has(hit.root)) byRoot.set(hit.root, []);
      byRoot.get(hit.root).push({ id, dir: hit.dir });
    }
    let freed = 0;
    for (const [root, list] of byRoot) {
      // Sized again now: the number reported is what actually went to the bin.
      const sizes = await Promise.all(list.map((it) => dirSize(it.dir)));
      const res = await trash(root, list.map((it) => it.dir));
      const moved = new Set((res && res.moved) || []);
      list.forEach((it, i) => { if (moved.has(it.dir)) freed += sizes[i]; else failed.push(it.id); });
    }
    return { ok: failed.length === 0, freed, failed };
  }

  return { overview, clean };
}

module.exports = { createVscodeSource, storageRoots, workspaceTarget };
