'use strict';
// Finds the folder a Claude Code project works in, read from the start of its newest
// transcript, and says whether a path is a folder.

const path = require('node:path');
const fsp = require('node:fs').promises;

const HEAD_BYTES = 65536;         // how much of a transcript we read to find cwd

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

module.exports = { HEAD_BYTES, readCwdFromTranscript, newestTranscript, isDir };
