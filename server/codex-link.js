'use strict';

// ── OpenAI Codex link — writes (and cleanly removes) Xenon's hooks in the
// user's Codex hooks.json ──────────────────────────────────────────────────
//
// The Codex twin of claude-link.js, and the second module that edits a file
// owned by ANOTHER application. Codex differs from Claude Code in three ways
// that shape everything here:
//
//   • A hook can only be a COMMAND, never an HTTP call. So each handler runs
//     codex-hook.js with the node that runs Xenon, and that script forwards to
//     the hub. The token is not on the command line (it is read from
//     DATA_DIR/codex-bridge.json), and neither is the port, so moving the hub
//     to another port never requires rewriting the user's file.
//   • Codex runs a hook only after the USER has trusted it in `/hooks`, and it
//     keys that trust on a hash of the handler (event, matcher, command,
//     timeout, status message) at its POSITION in the file. Two consequences:
//     Xenon never writes `trusted_hash` itself (that would be switching off
//     another app's safety check on the user's behalf), and every write here is
//     DETERMINISTIC and POSITION-PRESERVING. A relink that finds our handlers
//     already exactly right writes nothing; one that finds them out of date
//     replaces them where they stand. Moving them would shift the index of the
//     user's own hooks after them and silently cost the user THEIR trust too.
//   • Codex merges hooks.json with `[hooks]` in config.toml. We only ever
//     touch hooks.json, so a user's TOML hooks are never at risk from us.
//
// The rules shared with claude-link.js: back the original up once before the
// first write (byte for byte, never reformatted); only ever remove entries
// that are recognisably ours (a command that runs codex-hook.js); write
// through writeFileAtomic; refuse to touch a file we cannot parse, rather than
// treat it as empty and replace the user's hooks with ours.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./files/atomic-write');

const { HOOK_SCRIPT } = require('./codex/script-paths.js');
const STATE_FILE = 'codex-bridge.json';   // inside DATA_DIR
const BACKUP_SUFFIX = '.xenon-backup';


function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}
function hooksPath() {
  return path.join(codexHome(), 'hooks.json');
}

const { wrapperPath, wrapperBody, hookCommand } = require('./codex/link-command.js');
const {
  PERMISSION, LIFECYCLE, EXPECTED, ourHandler, isOurHandler, isOurCommand, sameHandler, locateOurs,
  withOurHooks, withoutOurHooks,
} = require('./codex/link-hooks-edit.js');

// ── file io ──────────────────────────────────────────────────────────────────
// { exists, raw, json } — json is null when the file exists but is not a JSON
// object, which callers must treat as "do not touch", never as "empty".
async function readHooksFile(file) {
  let raw;
  try { raw = await fs.promises.readFile(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, raw: '', json: {} };
    return { exists: true, raw: '', json: null };
  }
  if (!raw.trim()) return { exists: true, raw, json: {} };
  try {
    const j = JSON.parse(raw.replace(/^﻿/, ''));
    return { exists: true, raw, json: j && typeof j === 'object' && !Array.isArray(j) ? j : null };
  } catch { return { exists: true, raw, json: null }; }
}
function serialize(obj) { return JSON.stringify(obj, null, 2) + '\n'; }

async function readText(file) {
  try { return await fs.promises.readFile(file, 'utf8'); } catch { return null; }
}
const handlerFor = (wrapper) => (spec) => ourHandler(spec, process.platform, process.execPath, HOOK_SCRIPT, wrapper);
// Writes the Windows wrapper only when it differs, so a no-op relink stays a no-op.
async function ensureWrapper(dataDir) {
  const wrapper = wrapperPath(dataDir);
  if (!wrapper) return;
  const body = wrapperBody(process.execPath, HOOK_SCRIPT);
  if ((await readText(wrapper)) === body) return;
  await fs.promises.mkdir(path.dirname(wrapper), { recursive: true });
  await writeFileAtomic(wrapper, body);
}

async function readJson(file) {
  try {
    const j = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}
async function readState(dataDir) { return (await readJson(path.join(dataDir, STATE_FILE))) || {}; }
async function writeState(dataDir, state) {
  await writeFileAtomic(path.join(dataDir, STATE_FILE), JSON.stringify(state, null, 2));
}
// The token codex-hook.js presents. Created once and kept across relinks; the
// port is stored next to it because the hook script reads both from here.
async function ensureToken(dataDir, port) {
  const state = await readState(dataDir);
  const token = typeof state.token === 'string' && state.token.length >= 32 ? state.token : crypto.randomBytes(24).toString('hex');
  if (token !== state.token || (port && state.port !== port)) await writeState(dataDir, { ...state, token, ...(port ? { port } : {}) });
  return token;
}


// ── status ───────────────────────────────────────────────────────────────────
// `trust` is Codex's own verdict, from app-server hooks/list, passed in by the
// caller when it has one (null = unknown: the tile then explains /hooks).
async function status(dataDir, { trust = null } = {}) {
  const file = hooksPath();
  const f = await readHooksFile(file);
  const state = await readState(dataDir);
  const hooks = f.json && f.json.hooks && typeof f.json.hooks === 'object' ? f.json.hooks : {};
  const at = locateOurs(hooks);
  const missing = [];
  const outdated = [];
  const wrapper = wrapperPath(dataDir);
  for (const spec of EXPECTED) {
    const pos = at[spec.event];
    if (!pos) { missing.push(spec.event); continue; }
    if (!sameHandler(hooks[spec.event][pos[0]].hooks[pos[1]], handlerFor(wrapper)(spec))) outdated.push(spec.event);
  }
  const found = EXPECTED.length - missing.length;
  // The wrapper's own content (node/script path) can go stale without hooks.json changing.
  const wrapperStale = found > 0 && !!wrapper && (await readText(wrapper)) !== wrapperBody(process.execPath, HOOK_SCRIPT);
  return {
    linked: found > 0,
    complete: found === EXPECTED.length && outdated.length === 0 && !wrapperStale,
    missing,
    outdated,
    wrapperStale,
    unparsable: f.exists && f.json === null,
    hooksPath: file,
    exists: f.exists,
    backupExists: fs.existsSync(file + BACKUP_SUFFIX),
    linkedAt: state.linkedAt || 0,
    trust,
  };
}

// ── link / unlink / repair ───────────────────────────────────────────────────
async function link(dataDir, port) {
  const file = hooksPath();
  const f = await readHooksFile(file);
  if (f.json === null) return { ...(await status(dataDir)), error: 'unparsable' };
  await ensureToken(dataDir, port);
  await ensureWrapper(dataDir);
  const next = withOurHooks(f.json, handlerFor(wrapperPath(dataDir)));
  if (next !== f.json || !f.exists) {
    await fs.promises.mkdir(codexHome(), { recursive: true });
    // The untouched original, byte for byte, exactly once.
    const backup = file + BACKUP_SUFFIX;
    if (f.exists && f.raw && !fs.existsSync(backup)) await writeFileAtomic(backup, f.raw);
    await writeFileAtomic(file, serialize(next));
  }
  const state = await readState(dataDir);
  await writeState(dataDir, { ...state, port, linkedAt: state.linkedAt || Date.now(), createdFile: state.createdFile || !f.exists });
  return status(dataDir);
}

async function unlink(dataDir) {
  const file = hooksPath();
  const f = await readHooksFile(file);
  const state = await readState(dataDir);
  if (f.json) {
    const next = withoutOurHooks(f.json);
    if (next !== f.json) {
      // A file we created and that now holds nothing goes away with us.
      const empty = Object.keys(next).length === 0;
      if (empty && state.createdFile) { try { await fs.promises.unlink(file); } catch { /* gone */ } }
      else await writeFileAtomic(file, serialize(next));
    }
  }
  await writeState(dataDir, { token: state.token, port: state.port, linkedAt: 0 });
  const wrapper = wrapperPath(dataDir);
  if (wrapper) { try { await fs.promises.unlink(wrapper); } catch { /* never written */ } }
  return status(dataDir);
}

// Only a link the user made, and only when our handlers point at a node or a
// script that is no longer where it was (Node upgraded to another folder,
// Xenon moved). Every rewrite costs the user a re-trust in /hooks, so this runs
// at boot, never on a read, and reports `needsRetrust` for the tile to say so.
// Only a link this data folder made (it has a linkedAt): a second Xenon on
// another data folder must not point the user's hooks at its own wrapper.
async function repairLink(dataDir, port) {
  const st = await status(dataDir);
  if (!st.linked || st.complete || st.unparsable || !st.linkedAt) return { ...st, repaired: false };
  const next = await link(dataDir, port);
  // A stale wrapper alone is rewritten in place: hooks.json, and so the trust, is untouched.
  return { ...next, repaired: true, needsRetrust: st.missing.length + st.outdated.length > 0 };
}

module.exports = {
  link, unlink, status, repairLink, ensureToken, readState,
  codexHome, hooksPath, isOurCommand,
  // exported for tests
  hookCommand, ourHandler, wrapperPath, wrapperBody, isOurHandler, withOurHooks, withoutOurHooks, locateOurs, readHooksFile,
  EXPECTED, PERMISSION, LIFECYCLE, BACKUP_SUFFIX, HOOK_SCRIPT,
};

// ── CLI: `node server/codex-link.js unlink` ──────────────────────────────────
// Used by the uninstallers, for the same reason as claude-link.js: an
// uninstall that skipped this would leave Codex starting a script that no
// longer exists on every prompt, forever, with nothing to say where it came from.
if (require.main === module) {
  if (process.argv[2] !== 'unlink') {
    console.error('usage: node codex-link.js unlink');
    process.exit(2);
  }
  const dataDir = path.join(__dirname, 'data');
  (async () => {
    const before = await status(dataDir);
    if (!before.linked) { console.log('not-linked'); return; }
    await unlink(dataDir);
    try { fs.unlinkSync(before.hooksPath + BACKUP_SUFFIX); } catch { /* never existed */ }
    console.log('unlinked');
  })().catch((e) => {
    console.error(String((e && e.message) || e));
    process.exit(1);
  });
}
