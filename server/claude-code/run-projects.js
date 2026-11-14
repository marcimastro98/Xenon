'use strict';
// Where a run may start: the projects Claude Code already worked in, read from its transcripts,
// and the folders added by hand.

const path = require('node:path');
const fsp = require('node:fs').promises;
const { writeFileAtomic } = require('../atomic-write.js');
const { MAX_PROJECTS, MAX_FOLDERS, MAX_FOLDER_PATH, PROJECT_TTL_MS } = require('./run-limits.js');
const { readCwdFromTranscript, newestTranscript, isDir } = require('./run-project-folder.js');
const { str, projectId } = require('./run-text.js');

function makeProjects({ now, projectsDirOf, foldersFile, held }) {
  async function loadFolders() {
    if (held.extraFolders) return held.extraFolders;
    held.extraFolders = [];
    if (!foldersFile) return held.extraFolders;
    try {
      const raw = JSON.parse(await fsp.readFile(foldersFile, 'utf8'));
      for (const f of Array.isArray(raw) ? raw : []) {
        if (f && typeof f.path === 'string' && path.isAbsolute(f.path)) {
          held.extraFolders.push({ path: f.path, at: Number(f.at) || 0 });
        }
      }
    } catch { /* no file yet, or unreadable: start with none */ }
    held.extraFolders = held.extraFolders.slice(-MAX_FOLDERS);
    return held.extraFolders;
  }

  // A folder the user typed in: kept only if it is an absolute path to a real
  // directory that is not a filesystem root. Returns the project it becomes.
  async function addFolder(raw) {
    const text = str(raw, MAX_FOLDER_PATH).replace(/^"(.*)"$/, '$1');
    if (!text || !path.isAbsolute(text)) return { ok: false, error: 'bad_folder' };
    const dir = path.resolve(text);
    if (path.parse(dir).root === dir) return { ok: false, error: 'bad_folder' };
    if (!(await isDir(dir))) return { ok: false, error: 'folder_missing' };
    const list = await loadFolders();
    const key = dir.toLowerCase();
    const rest = list.filter(f => f.path.toLowerCase() !== key);
    held.extraFolders = rest.concat([{ path: dir, at: now() }]).slice(-MAX_FOLDERS);
    if (foldersFile) {
      try { await writeFileAtomic(foldersFile, JSON.stringify(held.extraFolders)); }
      catch { return { ok: false, error: 'save_failed' }; }
    }
    held.projectCache = { at: 0, list: [] };
    return { ok: true, id: projectId(dir), name: path.basename(dir) || dir, path: dir };
  }

  async function listProjects(force) {
    const t = now();
    if (!force && held.projectCache.list.length && (t - held.projectCache.at) < PROJECT_TTL_MS) return held.projectCache.list;

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
    const seenPaths = new Set(out.map(p => p.path.toLowerCase()));
    for (const f of await loadFolders()) {
      if (seenPaths.has(f.path.toLowerCase()) || !(await isDir(f.path))) continue;
      seenPaths.add(f.path.toLowerCase());
      out.push({ id: projectId(f.path), name: path.basename(f.path) || f.path, path: f.path, lastAt: f.at });
    }
    out.sort((a, b) => b.lastAt - a.lastAt);     // most recently worked in first
    held.projectCache = { at: t, list: out };
    return out;
  }

  return { addFolder, listProjects };
}

module.exports = { makeProjects };
