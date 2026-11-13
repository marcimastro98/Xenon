// What is cut out of a side copy of the engine (side-copy.mjs) and where each cut goes:
// the list, the engine files it is looked for in, and the one place it must be found.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Not copied: the data, what an install downloads, the tests, and the link to packages/core (made again).
export const NOT_COPIED = new Set(['data', 'whisper', 'test', 'shared', 'node_modules']);
// Not engine code: the browser's own files.
const NOT_ENGINE = new Set([...NOT_COPIED, 'js', 'components', 'styles', 'vendor', 'public', 'assets']);

/**
 * What is cut out of the copy, as [the engine's text, what stands there instead]. Each first text must be
 * in exactly one engine file (server/test/restructure-side-copy.test.mjs holds the real engine to that).
 */
export const CUTS = [
  ['function ensureHelperUpToDate(attempt = 1) {', 'function ensureHelperUpToDate(attempt = 1) { return;'],
  ['function ensureCaptureEngine(attempt = 1) {', 'function ensureCaptureEngine(attempt = 1) { return;'],
  ['async function reconcileBrowserAutoOpenTask() {', 'async function reconcileBrowserAutoOpenTask() { return;'],
  ['async function _syncRemoteHttps() {', 'async function _syncRemoteHttps() { return;'],
  ['autoUpdater.start().catch(', 'Promise.resolve().catch('],
  ['widgetAutoUpdater.start().catch(', 'Promise.resolve().catch('],
  ['    trialVault.init()\n      .then(() => trialPass.start())\n      .then(() => trialVault.sync())\n', '    Promise.resolve()\n'],
  ['const st = await claudeLink.repairLink(DATA_DIR, PORT);', 'const st = await claudeLink.status(DATA_DIR, PORT);'],
  ['return codexLink.repairLink(DATA_DIR, PORT); })', 'return null; })'],
  ["reqPath === '/startup/auto-open' && req.method === 'POST'", "false && reqPath === '/startup/auto-open' && req.method === 'POST'"],
];

/** @param {number} port @returns {string[][]} the cuts of a copy on that port: the frame counter gets a session name of its own */
export function cutsFor(port) {
  return [...CUTS, ["const ETW_SESSION_NAME = 'XenonFps';", `const ETW_SESSION_NAME = 'XenonFps${port}';`]];
}

/** @param {string} serverDir @returns {string[]} every engine script under it (not the browser's files, not what is never copied) */
export function engineFiles(serverDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (dir !== serverDir || !NOT_ENGINE.has(entry.name)) walk(path.join(dir, entry.name)); }
      else if (entry.name.endsWith('.js')) found.push(path.join(dir, entry.name));
    }
  };
  walk(serverDir);
  return found.sort();
}

/**
 * Where each cut goes, changing nothing: throws unless every cut is in exactly one engine file.
 * @param {string} serverDir @param {string[][]} cuts @returns {{ file: string, from: string, to: string }[]}
 */
export function placeCuts(serverDir, cuts) {
  const texts = engineFiles(serverDir).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  return cuts.map(([from, to]) => {
    const holders = texts.filter((entry) => entry.text.includes(from));
    const times = holders.length === 1 ? holders[0].text.split(from).length - 1 : 0;
    if (holders.length !== 1 || times !== 1) {
      throw new Error(`the cut "${from.trim().split('\n')[0].slice(0, 70)}" is in ${holders.length} engine files${holders.length === 1 ? ` (${times} times)` : ''}, it must be in one, once`);
    }
    return { file: holders[0].file, from, to };
  });
}

/** Makes every cut, or none when one does not fit. @param {string} serverDir @param {string[][]} cuts @returns {{ file: string, to: string }[]} */
export function makeCuts(serverDir, cuts) {
  const placed = placeCuts(serverDir, cuts);
  for (const cut of placed) writeFileSync(cut.file, readFileSync(cut.file, 'utf8').replace(cut.from, () => cut.to));
  return placed.map((cut) => ({ file: path.relative(serverDir, cut.file), to: cut.to }));
}
