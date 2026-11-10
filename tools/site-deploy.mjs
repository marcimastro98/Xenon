#!/usr/bin/env node
// Publishes xenon-app.com from this PC, the same way the "Deploy website" workflow does, for when
// GitHub Actions is down or stuck. It never touches this working copy: it checks out the ref in a
// temporary worktree (LF line endings, as on the CI runner), runs the workflow's own build steps
// (read from .github/workflows/pages.yml, so the two never drift), then the site tests, and only if
// every test passes deploys with wrangler. Any failure stops it before anything is published.
//
//   node tools/site-deploy.mjs              # origin/main after a fetch (or as last fetched)
//   node tools/site-deploy.mjs --ref main   # another ref
//   node tools/site-deploy.mjs --dry-run    # everything except the publish
//
// Needs: git; wrangler logged in on this PC (`npx wrangler login`); gh for /maker/ (a copy of the
// last maker.zip is kept in the user cache and used when GitHub does not answer).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = 'wrangler@4.110.0';
const MAKER_REPO = 'marcimastro98/xenon-maker';

/** The `node tools/*.mjs` build steps the workflow runs before it deploys, in order. */
export function builders(yml) {
  const text = String(yml).replace(/\r\n/g, '\n');
  const end = text.indexOf('wrangler@');
  if (end < 0) throw new Error('pages.yml has no wrangler deploy step');
  return [...text.slice(0, end).matchAll(/run: node (tools\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
}

/** The site tests, run on the built copy: every site-*.test.mjs plus the demo build check. */
export function siteTests(files) {
  return files.filter((f) => /^site-[\w-]+\.test\.mjs$/.test(f) || f === 'demo-build.test.mjs')
    .sort().map((f) => 'server/test/' + f);
}

/** Where the last good maker.zip is kept between runs. */
export function cacheDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'xenon-site-cache');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'xenon-site-cache');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'xenon-site-cache');
}

/**
 * The command that unpacks a zip: bsdtar ships with Windows 10+ and macOS, unzip with Linux. On
 * Windows by full path, since a GNU tar earlier on PATH (Git Bash) reads "C:" as a remote host.
 */
export function unzipCommand(platform, zip, dest, env = process.env) {
  if (platform === 'linux') return ['unzip', ['-q', '-o', zip, '-d', dest]];
  const tar = platform === 'win32' ? path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return [tar, ['-xf', zip, '-C', dest]];
}

/** wrangler's arguments, with the build's commit time the live /community/ copy is compared with. */
export function wranglerArgs(commitTime, dryRun) {
  if (!/^\d+$/.test(String(commitTime))) throw new Error('no commit time for SITE_COMMIT_TIME');
  const args = ['--yes', WRANGLER, 'deploy', '--config', 'site-host/wrangler.jsonc', '--var', 'SITE_COMMIT_TIME:' + commitTime];
  return dryRun ? args.concat('--dry-run') : args;
}

/** npx without a shell: npx.cmd cannot be spawned directly on Windows, its JS entry can. */
function npx() {
  if (process.platform !== 'win32') return ['npx', []];
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (!fs.existsSync(cli)) throw new Error('npx-cli.js not found next to node: ' + cli);
  return [process.execPath, [cli]];
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', cwd: opts.cwd || ROOT, env: { ...process.env, ...opts.env } });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFail) throw new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(' ')} exited with ${res.status}`);
  return res;
}

function parseArgs(argv) {
  const out = { ref: 'origin/main', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--ref' && argv[i + 1]) out.ref = argv[++i];
    else throw new Error('unknown argument: ' + argv[i]);
  }
  return out;
}

// /maker/ comes from the xenon-maker release; without it the deploy would drop the page.
function addMaker(dir) {
  const cache = cacheDir();
  const cached = path.join(cache, 'maker.zip');
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-maker-'));
  try {
    const got = run('gh', ['release', 'download', '--repo', MAKER_REPO, '--pattern', 'maker.zip', '--dir', dl], { allowFail: true, capture: true });
    if (got.status === 0) {
      fs.mkdirSync(cache, { recursive: true });
      fs.copyFileSync(path.join(dl, 'maker.zip'), cached);
    } else if (fs.existsSync(cached)) {
      console.log('! maker.zip not downloaded, using the copy from ' + fs.statSync(cached).mtime.toISOString().slice(0, 10));
    } else {
      throw new Error('maker.zip could not be downloaded and there is no cached copy: /maker/ would be lost');
    }
  } finally { fs.rmSync(dl, { recursive: true, force: true }); }
  const dest = path.join(dir, 'docs', 'maker');
  fs.mkdirSync(dest, { recursive: true });
  const [cmd, args] = unzipCommand(process.platform, cached, dest);
  run(cmd, args);
  if (!fs.existsSync(path.join(dest, 'index.html'))) throw new Error('maker.zip has no index.html');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.ref === 'origin/main') {
    const fetched = run('git', ['fetch', '--quiet', 'origin', 'main'], { allowFail: true });
    if (fetched.status !== 0) console.log('! GitHub did not answer: deploying origin/main as last fetched');
  }
  const sha = run('git', ['rev-parse', '--verify', opts.ref + '^{commit}'], { capture: true }).stdout.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-site-'));
  console.log(`> ${opts.ref} ${sha.slice(0, 8)} in ${dir}`);
  try {
    run('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'worktree', 'add', '--quiet', '--detach', dir, sha]);
    const at = { cwd: dir };
    // The tests check the committed site plus /demo/ (which only exists once built): run them
    // there, before /maker/ (its own repo, its own rules) and the generated copies arrive.
    run(process.execPath, ['tools/build-demo.mjs'], at);
    const tests = siteTests(fs.readdirSync(path.join(dir, 'server', 'test')));
    console.log(`> ${tests.length} site test files`);
    run(process.execPath, ['--test', ...tests], at);
    addMaker(dir);
    const yml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'pages.yml'), 'utf8');
    for (const step of builders(yml).filter((s) => s !== 'tools/build-demo.mjs')) {
      console.log('> node ' + step);
      run(process.execPath, [step], at);
    }
    const commitTime = run('git', ['log', '-1', '--format=%ct'], { ...at, capture: true }).stdout.trim();
    const [cmd, pre] = npx();
    run(cmd, pre.concat(wranglerArgs(commitTime, opts.dryRun)), at);
    console.log(opts.dryRun ? 'Dry run: nothing published.' : 'Live: https://xenon-app.com');
  } finally {
    run('git', ['worktree', 'remove', '--force', dir], { allowFail: true, capture: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error('site-deploy: ' + err.message + ' (nothing published)'); process.exit(1); }
}
