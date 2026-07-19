'use strict';

// Files and images you hand to Claude Code from the touchscreen. A `claude -p`
// run takes text and nothing else, so an attachment becomes a file on disk plus
// its path in the prompt: Claude reads it with its own Read tool, which means
// the read comes back to the Xeneon Edge as an approval card like any other.
// Nothing here grants Claude access to anything; it puts a file somewhere and
// names it.
//
// The boundaries:
//   * The client's filename NEVER reaches a path. It is kept only as a label to
//     show back on screen; what lands on disk is a name this module builds.
//   * Extensions are an allowlist, not a blocklist, and the bytes are capped.
//   * The directory lives under DATA_DIR, which is never HTTP-reachable, and is
//     pruned so a long-running install does not accumulate forever.

const fsp = require('fs/promises');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_LABEL = 80;
const KEEP_FILES = 40;             // prune to this many, newest first
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// Images Claude Code can look at, plus the plain-text shapes worth handing it.
// Anything executable is absent on purpose: the point is material to read.
const ALLOWED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml', '.xml', '.html', '.css',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp',
  '.sql', '.toml', '.ini', '.diff', '.patch', '.pdf',
]);

// A display label, not a path component: control characters and anything that
// could read as a directory separator are dropped, and the result is only ever
// echoed back to the UI.
function label(name) {
  const s = String(name == null ? '' : name);
  let out = '';
  for (let i = 0; i < s.length && out.length < MAX_LABEL; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) continue;
    const ch = s[i];
    if (ch === '/' || ch === '\\') continue;
    out += ch;
  }
  return out || 'file';
}

// The extension is read from the client's name but validated against the
// allowlist; a name with no usable extension is refused rather than guessed at.
function extOf(name) {
  const e = path.extname(String(name || '')).toLowerCase();
  return ALLOWED_EXT.has(e) ? e : '';
}

function createAttachments(opts) {
  const dir = (opts && opts.dir) || '';
  const now = (opts && opts.now) || Date.now;
  const rand = (opts && opts.rand) || (() => Math.random().toString(16).slice(2, 10));

  async function prune() {
    let names;
    try { names = await fsp.readdir(dir); } catch { return; }
    const t = now();
    const stats = [];
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        const st = await fsp.stat(p);
        if (st.isFile()) stats.push({ p, at: st.mtimeMs });
      } catch { /* vanished under us */ }
    }
    stats.sort((a, b) => b.at - a.at);
    for (let i = 0; i < stats.length; i++) {
      if (i < KEEP_FILES && (t - stats[i].at) < KEEP_MS) continue;
      await fsp.unlink(stats[i].p).catch(() => {});
    }
  }

  /**
   * @param {string} clientName the name the browser reported, used as a label only
   * @param {Buffer} data
   * @returns {Promise<{ok:boolean, error?:string, name?:string, path?:string, size?:number}>}
   */
  async function save(clientName, data) {
    if (!dir) return { ok: false, error: 'no_dir' };
    if (!Buffer.isBuffer(data) || !data.length) return { ok: false, error: 'empty' };
    if (data.length > MAX_BYTES) return { ok: false, error: 'too_big' };
    const ext = extOf(clientName);
    if (!ext) return { ok: false, error: 'bad_type' };

    try { await fsp.mkdir(dir, { recursive: true }); }
    catch { return { ok: false, error: 'no_dir' }; }

    const safeName = `attach-${now()}-${rand()}${ext}`;
    const full = path.join(dir, safeName);
    // Temp-file + rename, so a half-written attachment is never left behind for
    // Claude to read. `null` encoding: the payload is bytes, not text.
    try { await writeFileAtomic(full, data, null); }
    catch { return { ok: false, error: 'write_failed' }; }

    prune().catch(() => {});
    return { ok: true, name: label(clientName), path: full, size: data.length };
  }

  return { save, prune, _internal: { label, extOf, ALLOWED_EXT, MAX_BYTES } };
}

module.exports = { createAttachments, MAX_BYTES };
