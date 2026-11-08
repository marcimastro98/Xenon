#!/usr/bin/env node
// The test suite on real Linux, in a throwaway container. The working tree goes in as a tar: a
// bind mount of a Windows checkout would bring the junction at server/shared along. It runs as an
// ordinary user, because root passes every permission check. Needs Docker running; the exit code
// is the suite's.
//   node tools/linux-suite.mjs                                  every test
//   node tools/linux-suite.mjs server/test/linux-index.test.mjs  only these
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE = 'node:24-bookworm-slim';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function workingTree(paths) {
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z', ...paths], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split('\0').filter((file) => file && existsSync(path.join(ROOT, file)));
}

// Pipes the working tree (or only `paths`) into `script`, which unpacks it from its stdin.
export function runInContainer(script, paths = []) {
  const files = workingTree(paths);
  console.log(`${files.length} files into ${IMAGE}`);
  const tar = spawn('tar', ['-cf', '-', '--null', '-T', '-'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
  const docker = spawn('docker', ['run', '--rm', '-i', IMAGE, 'bash', '-c', script], { stdio: ['pipe', 'inherit', 'inherit'] });
  tar.stdin.end(`${files.join('\0')}\0`);
  tar.stdout.pipe(docker.stdin);
  docker.on('error', (error) => { console.error(`docker: ${error.message}`); process.exitCode = 1; });
  docker.on('exit', (code) => { process.exitCode = code ?? 1; });
}

function inContainer(tests) {
  const run = tests.length ? `node --test ${tests.map((file) => `'${file}'`).join(' ')}` : 'npm test';
  return [
    'set -e',
    'apt-get update -qq && apt-get install -y -qq --no-install-recommends git procps python3 > /dev/null',
    'mkdir -p /tmp/w && cd /tmp/w && tar xf -',
    'chown -R node:node /tmp/w',
    `su node -c "cd /tmp/w && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && node tools/link-shared.mjs && ${run}"`,
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInContainer(inContainer(process.argv.slice(2)));
}
