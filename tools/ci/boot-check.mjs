// Starts the real server, asks it for the dashboard and the action catalog, stops it, and
// fails when it did not answer or its output shows a crash. Used by
// .github/workflows/mac-linux-check.yml on macOS and Linux runners, where nobody looks
// at a screen; runs anywhere Node runs.
//
//   node tools/ci/boot-check.mjs [log file]      XENON_PORT picks the port (default 3039)

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOOT_LIMIT_MS = 60_000;
const POLL_MS = 500;

// Lines that mean the server broke, as opposed to a warning about a missing tool.
const CRASH = /Uncaught|Unhandled|TypeError|ReferenceError|SyntaxError|Cannot find module|FATAL|EADDRINUSE/;

/** What went wrong in one boot, or [] when it was clean. Pure, so it is tested. */
export function bootProblems({ pageStatus, catalog, output }) {
  const problems = [];
  if (pageStatus !== 200) problems.push(`the dashboard answered ${pageStatus ?? 'nothing'}`);
  if (!catalog || typeof catalog !== 'object') problems.push('the action catalog was not JSON');
  for (const line of String(output || '').split('\n')) {
    if (CRASH.test(line)) problems.push(`crash line: ${line.trim().slice(0, 300)}`);
  }
  return problems;
}

async function get(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    return { status: res.status, text };
  } catch {
    return null;
  }
}

async function main() {
  const logFile = process.argv[2];
  const port = process.env.XENON_PORT || '3039';
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT, env: { ...process.env, XENON_PORT: port }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  let page = null;
  const until = Date.now() + BOOT_LIMIT_MS;
  while (Date.now() < until && child.exitCode === null) {
    page = await get(base + '/');
    if (page) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const cat = page ? await get(base + '/actions/catalog') : null;
  let catalog = null;
  try { catalog = cat && cat.status === 200 ? JSON.parse(cat.text) : null; } catch { catalog = null; }
  const exitedEarly = child.exitCode !== null;
  child.kill();

  const problems = bootProblems({ pageStatus: page && page.status, catalog, output });
  if (exitedEarly) problems.unshift(`the server exited with code ${child.exitCode}`);
  const report = `Node ${process.version} on ${process.platform}\n${output}\n--- ${problems.length ? problems.join('\n') : 'clean boot'}\n`;
  if (logFile) writeFileSync(logFile, report);
  console.log(problems.length ? problems.join('\n') : `clean boot on Node ${process.version}, ${Object.keys(catalog).length} catalog keys`);
  process.exitCode = problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
