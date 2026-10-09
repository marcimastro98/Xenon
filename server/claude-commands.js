'use strict';

// The slash commands and skills a Claude Code run started from the Claude tile
// can use, for the tile's "/" picker. Names and one-line descriptions only:
// the picker inserts "/name " into the prompt and Claude Code itself expands it,
// exactly as it does for `claude -p "/name ..."` typed in a terminal.
//
// Read from the places Claude Code reads them:
//   <config>/commands/**/*.md            user commands ("a/b.md" → "/a:b")
//   <config>/skills/<name>/SKILL.md      user skills
//   <project>/.claude/commands|skills    the chosen project's own (the project
//                                        comes from the runner's allowlist by id)
//   enabled plugins' commands/ and skills/, named "<plugin>:<name>"
//
// Claude Code's built-in commands (/clear, /compact, /model…) are interactive
// and do nothing in a headless run, so they are not offered.
//
// Nothing here takes a path from the wire, and nothing is written. Every read
// is async and bounded: a few hundred files at most, and only each file's head.

const path = require('path');
const fsp = require('fs').promises;

const MAX_ENTRIES = 200;
const MAX_DESC = 140;
const HEAD_BYTES = 4096;
const MAX_DEPTH = 3;
const CACHE_MS = 60 * 1000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

async function readHead(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// The YAML frontmatter's flat `key: value` lines; enough for name, description
// and user-invocable, which is all this needs. A value in quotes loses them.
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  let block = '';   // a `key: >-` or `key: |` value continues on indented lines
  for (const line of m[1].split(/\r?\n/)) {
    if (block && /^\s+\S/.test(line)) { out[block] = (out[block] ? out[block] + ' ' : '') + line.trim(); continue; }
    block = '';
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) { block = key; out[key] = ''; continue; }
    out[key] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// No frontmatter description: the first line of prose stands in for it.
function firstLine(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line;
  }
  return '';
}

function clean(s, max) {
  const out = String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

async function listDir(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function commandsIn(dir, prefix, kind, out, depth) {
  if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
  for (const ent of await listDir(dir)) {
    if (out.length >= MAX_ENTRIES) return;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await commandsIn(full, prefix + ent.name + ':', kind, out, depth + 1);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      const text = await readHead(full);
      const fm = frontmatter(text);
      out.push({ name: prefix + ent.name.slice(0, -3), desc: fm.description || firstLine(text), kind });
    }
  }
}

async function skillsIn(dir, prefix, kind, out) {
  for (const ent of await listDir(dir)) {
    if (out.length >= MAX_ENTRIES) return;
    if (!ent.isDirectory()) continue;
    const text = await readHead(path.join(dir, ent.name, 'SKILL.md'));
    if (!text) continue;
    const fm = frontmatter(text);
    if (String(fm['user-invocable']).toLowerCase() === 'false') continue;
    out.push({ name: prefix + (fm.name || ent.name), desc: fm.description || firstLine(text), kind });
  }
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

// Installed plugins that the user's settings have not switched off.
async function enabledPlugins(configDir) {
  const installed = await readJson(path.join(configDir, 'plugins', 'installed_plugins.json'));
  const settings = await readJson(path.join(configDir, 'settings.json'));
  const enabled = (settings && settings.enabledPlugins) || {};
  const out = [];
  const plugins = (installed && installed.plugins) || {};
  for (const key of Object.keys(plugins)) {
    if (enabled[key] === false) continue;
    const entry = Array.isArray(plugins[key]) ? plugins[key][0] : null;
    if (!entry || typeof entry.installPath !== 'string') continue;
    out.push({ name: key.split('@')[0], dir: entry.installPath });
  }
  return out;
}

function createCommandList(opts) {
  const o = opts || {};
  const configDirOf = typeof o.configDir === 'function' ? o.configDir : () => '';
  const projectDirOf = typeof o.projectDir === 'function' ? o.projectDir : async () => '';
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const cache = new Map();   // projectId → { at, list }

  async function list(projectId) {
    const key = String(projectId || '');
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.list;

    const configDir = configDirOf();
    const raw = [];
    const projectDir = key ? await projectDirOf(key) : '';
    if (projectDir) {
      await commandsIn(path.join(projectDir, '.claude', 'commands'), '', 'project', raw, 0);
      await skillsIn(path.join(projectDir, '.claude', 'skills'), '', 'project', raw);
    }
    if (configDir) {
      await commandsIn(path.join(configDir, 'commands'), '', 'user', raw, 0);
      await skillsIn(path.join(configDir, 'skills'), '', 'user', raw);
      for (const p of await enabledPlugins(configDir)) {
        await commandsIn(path.join(p.dir, 'commands'), p.name + ':', 'plugin', raw, 0);
        await skillsIn(path.join(p.dir, 'skills'), p.name + ':', 'plugin', raw);
      }
    }
    // The first of a name wins: the project's own shadows the user's, which
    // shadows a plugin's, as in Claude Code.
    const seen = new Set();
    const out = [];
    for (const c of raw) {
      if (!NAME_RE.test(c.name) || seen.has(c.name.toLowerCase())) continue;
      seen.add(c.name.toLowerCase());
      out.push({ name: c.name, desc: clean(c.desc, MAX_DESC), kind: c.kind });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    if (cache.size > 50) cache.clear();
    cache.set(key, { at: now(), list: out });
    return out;
  }

  return { list };
}

module.exports = { createCommandList, _internal: { frontmatter, firstLine, clean, NAME_RE } };
