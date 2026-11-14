'use strict';
// Finds the transcript file of a Claude Code session by its id inside Claude Code's own
// projects folder, and remembers the answer for a while.

const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_PROJECT_DIRS = 200;
const FIND_TTL_MS = 5 * 60 * 1000;
// A miss is remembered briefly only: a session that just started has no file
// yet, and its title and thread must show up once Claude Code writes one.
const FIND_MISS_TTL_MS = 15 * 1000;

// Where a session's transcript lives. Claude Code files them under a directory
// per project, so the session has to be looked for; the answer is cached
// because the panel re-reads while it is open.
// Keyed on the projects directory as well as the session: the directory is
// resolvable to different places (a different HOME, a test fixture), and a key
// of session-id alone would serve one root's answer for another's question.
const findCache = new Map();     // projectsDir + '|' + sessionId → { file, at }

async function findTranscript(projectsDir, sessionId, now) {
  const cacheKey = projectsDir + '|' + sessionId;
  const hit = findCache.get(cacheKey);
  if (hit && (now - hit.at) < (hit.file ? FIND_TTL_MS : FIND_MISS_TTL_MS)) return hit.file;

  let dirs;
  try { dirs = await fsp.readdir(projectsDir, { withFileTypes: true }); }
  catch { return ''; }

  const want = sessionId + '.jsonl';
  let found = '';
  let scanned = 0;
  for (const d of dirs) {
    if (!d.isDirectory() || ++scanned > MAX_PROJECT_DIRS) continue;
    const candidate = path.join(projectsDir, d.name, want);
    try {
      const st = await fsp.stat(candidate);
      // isFile() and not a link target: a symlink pointing elsewhere must not
      // become a read of whatever it points at.
      if (st.isFile()) { found = candidate; break; }
    } catch { /* not in this project */ }
  }
  findCache.set(cacheKey, { file: found, at: now });
  if (findCache.size > 100) findCache.delete(findCache.keys().next().value);
  return found;
}

module.exports = { MAX_PROJECT_DIRS, FIND_TTL_MS, FIND_MISS_TTL_MS, findCache, findTranscript };
