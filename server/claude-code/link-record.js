'use strict';
// The link's own record in the data folder: a JSON file read without throwing, the record read
// and written, and the token and the port kept in it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('../atomic-write.js');

const STATE_FILE = 'claude-bridge.json';   // inside DATA_DIR

async function readJson(file) {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch { return null; }
}

// ── hub-side state (token + what we replaced) ────────────────────────────────
async function readState(dataDir) {
  const s = await readJson(path.join(dataDir, STATE_FILE));
  return s || {};
}
async function writeState(dataDir, state) {
  await writeFileAtomic(path.join(dataDir, STATE_FILE), JSON.stringify(state, null, 2));
}

// The token is created once and reused, so relinking (or changing port) doesn't
// invalidate a config the user already has on disk.
async function ensureToken(dataDir) {
  const state = await readState(dataDir);
  if (typeof state.token === 'string' && state.token.length >= 32) return state.token;
  const token = crypto.randomBytes(24).toString('hex');
  await writeState(dataDir, { ...state, token });
  return token;
}

module.exports = { STATE_FILE, readJson, readState, writeState, ensureToken };
