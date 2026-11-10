// tools/site-deploy.mjs publishes the site from a PC when GitHub Actions cannot. It must build
// exactly what the workflow builds and stop before the publish on any failure: these pin the
// parts that decide what it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builders, siteTests, cacheDir, unzipCommand, wranglerArgs } from '../../tools/site-deploy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8');

test('the local deploy runs the same build steps as the workflow, in order', () => {
  const steps = builders(WORKFLOW);
  const inYml = [...WORKFLOW.replace(/\r\n/g, '\n').matchAll(/run: node (tools\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
  assert.deepEqual(steps, inYml.slice(0, steps.length));
  for (const name of ['tools/build-demo.mjs', 'tools/build-i18n.mjs', 'tools/build-seo.mjs']) assert.ok(steps.includes(name), name);
  for (const step of steps) assert.ok(fs.existsSync(path.join(ROOT, step)), step);
});

test('a workflow with no wrangler step is refused', () => {
  assert.throws(() => builders('steps:\n  - run: node tools/build-seo.mjs\n'), /wrangler/);
});

test('the site tests are the site-* files plus the demo build check', () => {
  const files = ['site-seo.test.mjs', 'demo-build.test.mjs', 'deck.test.mjs', 'site-host.test.mjs', 'site-x.js', 'website.test.mjs'];
  assert.deepEqual(siteTests(files), ['server/test/demo-build.test.mjs', 'server/test/site-host.test.mjs', 'server/test/site-seo.test.mjs']);
});

test('the maker cache lives in the user cache folder of each OS', () => {
  assert.equal(cacheDir('win32', { LOCALAPPDATA: 'C:\\U\\AppData\\Local' }, 'C:\\U'), path.join('C:\\U\\AppData\\Local', 'xenon-site-cache'));
  assert.equal(cacheDir('darwin', {}, '/Users/u'), path.join('/Users/u', 'Library', 'Caches', 'xenon-site-cache'));
  assert.equal(cacheDir('linux', { XDG_CACHE_HOME: '/x' }, '/home/u'), path.join('/x', 'xenon-site-cache'));
  assert.equal(cacheDir('linux', {}, '/home/u'), path.join('/home/u', '.cache', 'xenon-site-cache'));
});

test('zips are unpacked with the system tar on Windows (not a GNU tar on PATH), unzip on Linux', () => {
  const [win, winArgs] = unzipCommand('win32', 'C:\\c\\maker.zip', 'C:\\d', { SystemRoot: 'C:\\Windows' });
  assert.equal(win, 'C:\\Windows\\System32\\tar.exe');
  assert.deepEqual(winArgs, ['-xf', 'C:\\c\\maker.zip', '-C', 'C:\\d']);
  assert.equal(unzipCommand('win32', 'z', 'd', {})[0], 'C:\\Windows\\System32\\tar.exe');
  assert.deepEqual(unzipCommand('linux', 'z', 'd'), ['unzip', ['-q', '-o', 'z', '-d', 'd']]);
  assert.equal(unzipCommand('darwin', 'z', 'd')[0], 'tar');
});

test('wrangler gets the commit time and the same pinned version and config as the workflow', () => {
  const args = wranglerArgs('1762790400', false);
  assert.deepEqual(args.slice(-2), ['--var', 'SITE_COMMIT_TIME:1762790400']);
  const pinned = /wrangler@[\d.]+/.exec(WORKFLOW)[0];
  assert.ok(args.includes(pinned), 'same wrangler as pages.yml: ' + pinned);
  assert.ok(WORKFLOW.includes('--config ' + args[args.indexOf('--config') + 1]));
  assert.equal(wranglerArgs('1', true).at(-1), '--dry-run');
  for (const bad of ['', 'abc', '12 34', undefined]) assert.throws(() => wranglerArgs(bad, false), /commit time/);
});
