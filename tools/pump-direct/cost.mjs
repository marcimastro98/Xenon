#!/usr/bin/env node
// What the hidden browser that draws a pump's screen costs (pump-screen/direct-browser.js):
// a throwaway engine on its own port and data (never the PC's 3030, never a pump), the same
// browser and page the direct route opens, filmed at the same pace, for a few faces and ways of
// starting the browser. For each it says the browser's processes, the pictures a second it
// sends, its share of one core and its memory (its own and in use). Windows and Linux.
//
//   node tools/pump-direct/cost.mjs [--seconds 20] [--faces still,art,picture] [--try "<flags>"] [--json <file>] [--out <dir>]
//
// The average size of a picture is shown too (a black one is a few KB), and --out keeps the last
// picture of each run, to see that a flag did not leave the screen black.
//
// --try measures the browser a second time with more flags (direct-start.js PUMP_BROWSER_FLAGS
// holds the ones it starts with), so a flag is measured here before it goes in. Numbers move with what else the PC is doing: compare
// runs made together, and run twice before believing a small difference.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startRig } from '../ci/engine-rig.mjs';
import { processRows, treeOf, usageBetween } from './process-usage.mjs';
import { PANEL } from './report-stream.mjs';

const require = createRequire(import.meta.url);
const { createDirectBrowser } = require('../../server/pump-screen/direct-browser.js');
const { readDevToolsPort, killProcessTree } = require('../../server/windows-tiles/browser-launch.js');
const { findEdge } = require('../../server/windows-tiles/browser-find.js');
const { FPS, QUALITY, pumpBrowserArgs, faceUrl } = require('../../server/pump-screen/direct-start.js');
const WebSocket = require('ws');

const PORT = 3051;
const SCREEN = 'pump';
const WARM_MS = 6000;
const PORT_WAIT_MS = 15000;

// What the pump shows while it is measured: a still face, the same face over a moving picture
// Xenon draws, and a moving picture alone.
export const FACES = Object.freeze({
  still: { face: 'sensors', bg: 'black' },
  art: { face: 'sensors', bg: 'art:ember' },
  picture: { face: 'picture', items: ['art:aurora'] },
});
// The pump browser as it starts, and (--try) with more flags on top.
export const VARIANTS = Object.freeze({ usual: [] });

export function parseArgs(argv) {
  const out = { seconds: 20, faces: Object.keys(FACES), variants: { ...VARIANTS }, json: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === '--seconds') { out.seconds = Math.max(5, Number(v) || 20); i++; }
    else if (k === '--faces') { out.faces = String(v).split(','); i++; }
    else if (k === '--try') { out.variants.tried = String(v).split(/\s+/).filter((f) => /^--[a-z0-9-]+(=\S*)?$/i.test(f)); i++; }
    else if (k === '--json') { out.json = String(v); i++; }
    else if (k === '--out') { out.out = String(v); i++; }
    else throw new Error(`unknown option ${k}`);
  }
  const bad = out.faces.filter((f) => !FACES[f]);
  if (bad.length) throw new Error(`unknown face: ${bad.join(', ')}`);
  if (out.variants.tried && !out.variants.tried.length) throw new Error('--try takes flags such as "--mute-audio --foo=bar"');
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchEdge(profileDir, extra, onProc) {
  const exe = findEdge();
  if (!exe) throw new Error('no Edge or Chrome found');
  const proc = spawn(exe, pumpBrowserArgs(profileDir, extra), { windowsHide: true, stdio: 'ignore' });
  proc.on('error', () => {});
  onProc(proc);
  const { port, wsPath } = await readDevToolsPort(path.join(profileDir, 'DevToolsActivePort'), PORT_WAIT_MS);
  return { proc, wsUrl: `ws://127.0.0.1:${port}${wsPath}` };
}

async function measure(rig, face, [variant, flags], seconds, out) {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'xenon-pump-cost-'));
  const frames = [];
  let proc = null;
  let last = null;
  let failed = '';
  const url = faceUrl(PORT, SCREEN, PANEL);
  const browser = createDirectBrowser({
    launch: () => launchEdge(profileDir, flags, (p) => { proc = p; }), WebSocketImpl: WebSocket, kill: killProcessTree,
    url, width: PANEL.width, height: PANEL.height, fps: FPS, quality: QUALITY,
    onFrame: (jpeg) => { frames.push(jpeg.length); last = jpeg; }, onError: (why) => { failed = why; },
  });
  try {
    await browser.start();
    const set = await rig.ask('POST', '/pump', { screen: SCREEN, patch: { base: FACES[face], moments: [] } });
    if (!set?.json?.screens) throw new Error(`the face was not set: ${set?.text?.slice(0, 200)}`);
    await sleep(WARM_MS);
    const before = treeOf(await processRows(), proc.pid);
    const [t0, f0] = [Date.now(), frames.length];
    await sleep(seconds * 1000);
    const after = treeOf(await processRows(), proc.pid);
    const ms = Date.now() - t0;
    if (failed) throw new Error(`the browser failed: ${failed}`);
    if (out && last) writeFileSync(path.join(out, `${face}-${variant}.jpg`), last);
    const sizes = frames.slice(f0);
    const kb = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length / 1024) : 0;
    return { face, variant, fps: Math.round((sizes.length / (ms / 1000)) * 10) / 10, kb, ...usageBetween(before, after, ms) };
  } finally {
    browser.stop();
    await sleep(1500);
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.out) mkdirSync(opts.out, { recursive: true });
  const rig = await startRig({ port: PORT });
  const results = [];
  try {
    if (!rig.up) throw new Error(`the engine did not start:\n${rig.output().slice(-2000)}`);
    for (const face of opts.faces) {
      for (const variant of Object.entries(opts.variants)) {
        const r = await measure(rig, face, variant, opts.seconds, opts.out);
        results.push(r);
        console.log(`${face.padEnd(8)} ${r.variant.padEnd(7)} ${String(r.processes).padStart(2)} processes  ${String(r.fps).padStart(4)} pictures/s (${r.kb} KB)  ${String(r.corePercent).padStart(5)}% of a core  ${String(r.privateMb).padStart(4)} MB own  ${String(r.workingMb).padStart(4)} MB in use`);
      }
    }
  } finally {
    await rig.stop();
  }
  if (opts.json) writeFileSync(opts.json, JSON.stringify(results, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
