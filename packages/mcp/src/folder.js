'use strict';
// The widget lives in a folder the author picks. This file is the only one
// that touches it: it reads the folder into the payload Xenon installs
// ({ path, data(base64) }), and writes a starter or a pulled widget back.
//
// The limits and the path rules are Xenon's own (server/sdk-widgets.js
// validateWidgetPayload): checking them here first means the author hears
// "this file is skipped, and why" instead of a bare refusal from the server.
const fs = require('fs');
const path = require('path');

const MAX_FILES = 40;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const MAX_DEPTH = 8;
const EXTENSIONS = new Set(['.html', '.htm', '.js', '.css', '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.woff', '.woff2', '.txt', '.md']);
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Never part of a widget: tooling, version control, dependencies.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

const okSegment = (s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..' && !s.startsWith('..');

// The id Xenon installs under: the one given, else the folder's own name.
function widgetId(folder, given) {
  const id = String(given || path.basename(path.resolve(String(folder || ''))) || '').trim().toLowerCase();
  return WIDGET_ID_RE.test(id) ? id : null;
}

async function walk(root, rel, depth, out) {
  if (depth > MAX_DEPTH) { out.skipped.push({ path: rel || '.', why: 'too deep' }); return; }
  const entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const relPath = rel ? rel + '/' + e.name : e.name;
    if (e.name.startsWith('.')) continue;   // .git, .vscode, .DS_Store: never sent, never listed
    if (e.isSymbolicLink()) { out.skipped.push({ path: relPath, why: 'link' }); continue; }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (!okSegment(e.name)) { out.skipped.push({ path: relPath, why: 'name' }); continue; }
      await walk(root, relPath, depth + 1, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (!okSegment(e.name)) { out.skipped.push({ path: relPath, why: 'name' }); continue; }
    if (!EXTENSIONS.has(path.extname(e.name).toLowerCase())) { out.skipped.push({ path: relPath, why: 'type' }); continue; }
    out.found.push(relPath);
  }
}

// { ok, files, skipped } or { ok:false, error, hint }.
async function readWidgetFolder(folder) {
  const root = path.resolve(String(folder || ''));
  let st;
  try { st = await fs.promises.stat(root); } catch { return { ok: false, error: 'no_folder', hint: 'That folder does not exist: ' + root }; }
  if (!st.isDirectory()) return { ok: false, error: 'not_a_folder', hint: 'Give the folder that holds manifest.json, not a file.' };
  const out = { found: [], skipped: [] };
  await walk(root, '', 0, out);
  if (!out.found.includes('manifest.json')) return { ok: false, error: 'missing_manifest', hint: 'The folder needs a manifest.json at its top. Call new_widget for a starter.' };
  if (out.found.length > MAX_FILES) return { ok: false, error: 'too_many_files', hint: `A widget holds at most ${MAX_FILES} files; this folder has ${out.found.length}.` };
  const files = [];
  let total = 0;
  for (const rel of out.found) {
    const bytes = await fs.promises.readFile(path.join(root, rel));
    if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: 'file_too_large', hint: `${rel} is over ${MAX_FILE_BYTES / 1024} KB.` };
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) return { ok: false, error: 'too_large', hint: `A widget is at most ${MAX_TOTAL_BYTES / 1024 / 1024} MB in all.` };
    files.push({ path: rel, data: bytes.toString('base64') });
  }
  return { ok: true, files, skipped: out.skipped };
}

// Where one file of a payload lands, or null when its path could leave the
// folder. The payload came from Xenon, but the folder is the author's.
function targetPath(root, rel) {
  const segs = String(rel || '').split('/');
  if (!segs.length || segs.length > MAX_DEPTH || !segs.every(okSegment)) return null;
  if (!EXTENSIONS.has(path.extname(segs[segs.length - 1]).toLowerCase())) return null;
  const full = path.resolve(root, ...segs);
  return full.startsWith(root + path.sep) ? full : null;
}

// Writes files into a new or empty folder; one that has anything in it is
// left alone unless `overwrite`, so a pull never eats someone's work.
async function writeWidgetFolder(folder, files, { overwrite = false } = {}) {
  const root = path.resolve(String(folder || ''));
  let existing = null;
  try { existing = await fs.promises.readdir(root); } catch { existing = null; }
  if (existing && existing.length && !overwrite) {
    return { ok: false, error: 'folder_not_empty', hint: 'That folder already has files. Pick a new folder, or pass overwrite: true to replace the files with the same names.' };
  }
  const plan = [];
  for (const f of Array.isArray(files) ? files : []) {
    const full = targetPath(root, f && f.path);
    if (!full) return { ok: false, error: 'bad_path', hint: 'Xenon sent a file path that is not allowed: ' + String(f && f.path).slice(0, 80) };
    plan.push({ full, bytes: Buffer.from(String((f && f.data) || ''), 'base64') });
  }
  for (const p of plan) {
    await fs.promises.mkdir(path.dirname(p.full), { recursive: true });
    await fs.promises.writeFile(p.full, p.bytes);
  }
  return { ok: true, folder: root, written: plan.map((p) => path.relative(root, p.full).split(path.sep).join('/')) };
}

module.exports = { readWidgetFolder, writeWidgetFolder, widgetId, targetPath, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES };
