#!/usr/bin/env node
// Puts the dev code (a git ref of this checkout, HEAD by default) on the Xenon
// installed on this PC, through that install's own updater: it stages the tree
// where the server's prepare step would (server\data\update\app + staged.json)
// and runs the installed update-apply.ps1 -NoElevate. So the swap is the real
// one: backup, stale-file cleanup, hand-off to the new updater, npm, restart
// through the task, /version check, rollback on failure. User data is never
// copied over. Only the signature check of a downloaded release is skipped:
// the files come from this checkout, not from the network.
//
//   node tools/dev-install/cli.mjs [--ref <git-ref>] [--dry-run]
//
// Windows only for now (the installs it updates are Windows installs).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_NAME, installRootFromTaskXml, refuseRoot, stagedJson, readOutcome } from './lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sys32 = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');
const WAIT_MS = 10 * 60 * 1000;
const PORT = 3030;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function taskXml() {
  const buf = execFileSync(path.join(sys32, 'schtasks.exe'), ['/Query', '/TN', TASK_NAME, '/XML', 'ONE'], { windowsHide: true });
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le', 2) : buf.toString('utf8');
}

const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' }).trim();

// git archive honours export-ignore, so the staged tree is what a release zip ships.
function stageTree(ref, appDir) {
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', ref], { cwd: repoRoot, windowsHide: true });
    const tar = spawn(path.join(sys32, 'tar.exe'), ['-xf', '-', '-C', appDir], { windowsHide: true });
    archive.stdout.pipe(tar.stdin);
    let err = '';
    archive.stderr.on('data', (d) => { err += d; });
    tar.stderr.on('data', (d) => { err += d; });
    archive.on('error', reject);
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error('tar exit ' + code + ': ' + err.trim()))));
  });
}

// The running engine starts the applier, exactly as the app's Update button
// does: it may run elevated, and only a process it started can stop it. With no
// engine answering there is nothing to stop, so the installed applier is run
// directly (it relaunches itself as a detached worker and returns at once).
async function startApply(root) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/update/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000),
    });
    const r = await res.json();
    if (r && r.ok) return;
    throw new Error('the engine refused the apply: ' + JSON.stringify(r));
  } catch (e) {
    if (!/fetch failed|ECONNREFUSED|timeout/i.test(String(e && (e.cause?.code || e.message)))) throw e;
  }
  const ps = path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'server', 'update-apply.ps1'), '-NoElevate'],
    { windowsHide: true, env: { ...process.env, XENON_UPDATE_QUIET: '1' }, stdio: 'inherit' });
}

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only for now.');
  const ref = arg('--ref', 'HEAD');
  const dryRun = process.argv.includes('--dry-run');

  const root = installRootFromTaskXml(taskXml());
  const refusal = refuseRoot(root, repoRoot, fs.existsSync);
  if (refusal) throw new Error(refusal);

  const commit = git('rev-parse', '--short', ref);
  const version = JSON.parse(git('show', ref + ':package.json')).version;
  const installed = JSON.parse(readText(path.join(root, 'package.json')) || '{}').version || '?';
  const dirty = git('status', '--porcelain').split('\n').filter(Boolean).length;
  console.log(`install: ${root}\ninstalled ${installed} -> ${version} (${ref} ${commit})`);
  if (dirty) console.log(`note: ${dirty} uncommitted change(s) in the checkout are NOT included`);
  if (dryRun) return;

  const dataDir = path.join(root, 'server', 'data');
  const updDir = path.join(dataDir, 'update');
  const resultPath = path.join(dataDir, 'update-result.json');
  await stageTree(ref, path.join(updDir, 'app'));
  fs.writeFileSync(path.join(updDir, 'staged.json'), stagedJson(version, ref, commit));
  console.log('staged');

  const before = readText(resultPath);
  await startApply(root);
  console.log('applying (engine restarts)...');

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    const out = readOutcome(before, readText(resultPath));
    if (!out.done) continue;
    console.log(out.ok ? `OK ${out.detail}` : `FAILED ${out.detail}`);
    process.exitCode = out.ok ? 0 : 1;
    return;
  }
  console.log('no result after 10 minutes, see ' + path.join(updDir, 'update.log'));
  process.exitCode = 1;
}

main().catch((e) => { console.error('dev-install: ' + e.message); process.exitCode = 1; });
