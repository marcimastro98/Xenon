// The cut copy of the engine a page check runs against (tools/restructure/side-copy.mjs):
// every cut still fits the real engine in exactly one place, so a moved function fails
// here and not on the PC; a copy whose cuts did not all go in never starts; the tool
// refuses the installed app's port and any folder it did not make; it stops what it started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CUTS, MARKER_ADDRESS, RESIZE_NOTICE, build, cutProblems, cutsFor, engineFiles, mustBeSideCopy, onlyResizeNotice, placeCuts, recordUntilSame, run, sidePort, sideRoot,
} from '../../tools/restructure/side-copy.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SERVER = path.join(REPO, 'server');

// A stand-in checkout: an engine that holds every cut once and answers its own files.
function fakeRepo(t, { without } = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'xenon-side-copy-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  mkdirSync(path.join(repo, 'server', 'install'), { recursive: true });
  mkdirSync(path.join(repo, 'server', 'test'), { recursive: true });
  mkdirSync(path.join(repo, 'server', 'js'), { recursive: true });
  mkdirSync(path.join(repo, 'packages', 'core'), { recursive: true });
  const lines = CUTS.map(([from]) => from).filter((from) => from !== without);
  writeFileSync(path.join(repo, 'server', 'install', 'held.js'), `/*\n${lines.join('\n')}\n*/\n`);
  writeFileSync(path.join(repo, 'server', 'fpsmon.js'), "const ETW_SESSION_NAME = 'XenonFps';\n");
  // The browser's files may quote an engine line: they are not engine files, so the cut is still in one place.
  writeFileSync(path.join(repo, 'server', 'js', 'page.js'), `// ${CUTS[0][0]}\n`);
  writeFileSync(path.join(repo, 'server', 'test', 'never-copied.js'), '// a test\n');
  writeFileSync(path.join(repo, 'server', 'server.js'), [
    "const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');",
    'http.createServer((req, res) => fs.readFile(path.join(__dirname, req.url), (error, data) => { res.writeHead(error ? 404 : 200); res.end(data); }))',
    "  .listen(Number(process.env.XENON_PORT), '127.0.0.1');",
    "fs.writeFileSync(path.join(__dirname, 'data', 'home.txt'), [process.env.USERPROFILE, process.env.HOME, process.env.LOCALAPPDATA, process.env.APPDATA, process.env.TEMP].join('\\n'));",
  ].join('\n'));
  return { repo, root: path.join(repo, '..', `${path.basename(repo)}-copy`) };
}

const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test('every cut is still in exactly one file of the real engine, once', () => {
  const placed = placeCuts(SERVER, cutsFor(3043));
  assert.equal(placed.length, CUTS.length + 1);
  for (const cut of placed) assert.ok(engineFiles(SERVER).includes(cut.file), cut.from);
});

test('the cut that keeps the logon task alone is among them, and the function it empties is the one the engine calls a minute after start', () => {
  const cut = placeCuts(SERVER, CUTS).find((entry) => entry.from.includes('reconcileBrowserAutoOpenTask'));
  assert.match(cut.to, /\{ return;$/);
  const tidy = engineFiles(SERVER).map((file) => readFileSync(file, 'utf8')).find((text) => text.includes('function tidyLeftoverTasks()'));
  assert.match(tidy, /function tidyLeftoverTasks\(\) \{[^}]*reconcileBrowserAutoOpenTask\(\)/);
});

test('the port of the installed app and anything that is not a port are refused', () => {
  assert.equal(sidePort('3043'), 3043);
  assert.throws(() => sidePort('3030'), /installed app/);
  assert.throws(() => sidePort(3030), /installed app/);
  for (const bad of ['', 'http', '80', '99999', '30 30']) assert.throws(() => sidePort(bad), /not a port/, bad);
});

test('the folder of a copy is never the checkout, inside it, around it, or a folder with files of someone else', (t) => {
  const { repo } = fakeRepo(t);
  assert.throws(() => sideRoot(repo, repo), /checkout/);
  assert.throws(() => sideRoot(path.join(repo, 'server'), repo), /checkout/);
  assert.throws(() => sideRoot(path.dirname(repo), repo), /checkout/);
  const foreign = mkdtempSync(path.join(os.tmpdir(), 'xenon-side-copy-foreign-'));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  writeFileSync(path.join(foreign, 'notes.txt'), 'not ours\n');
  assert.throws(() => sideRoot(foreign, repo), /did not put there/);
  assert.equal(sideRoot(path.join(foreign, 'new'), repo), path.join(foreign, 'new'));
});

test('a build makes every cut, leaves the tests and the browser files alone, and writes the marker the page check asks for', async (t) => {
  const { repo, root } = fakeRepo(t);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const port = await freePort();
  assert.match(await build(root, port, undefined, repo), new RegExp(`built for port ${port}: ${CUTS.length + 1} cuts made`));
  const held = readFileSync(path.join(root, 'server', 'install', 'held.js'), 'utf8');
  for (const [from, to] of CUTS) { assert.ok(held.includes(to), to); assert.ok(!held.replaceAll(to, '').includes(from), from); }
  assert.match(readFileSync(path.join(root, 'server', 'fpsmon.js'), 'utf8'), new RegExp(`'XenonFps${port}'`));
  assert.equal(readFileSync(path.join(root, 'server', 'js', 'page.js'), 'utf8'), `// ${CUTS[0][0]}\n`);
  assert.equal(existsSync(path.join(root, 'server', 'test')), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'server', MARKER_ADDRESS), 'utf8')), { sideCopy: true, port });
  assert.deepEqual(cutProblems(root, port), []);
  assert.match(cutProblems(root, port + 1).join('\n'), /built for port/);
  // Building again over its own folder is allowed; a cut put back by hand is seen before a start.
  await build(root, port, undefined, repo);
  writeFileSync(path.join(root, 'server', 'install', 'held.js'), '// the cuts are gone\n');
  assert.match(cutProblems(root, port).join('\n'), /the cut in install.held\.js is gone/);
  await assert.rejects(run(root, port, 1, repo), /the cut in/);
});

test('when one cut no longer fits, the build fails, nothing says the copy is cut, and it does not start', async (t) => {
  const { repo, root } = fakeRepo(t, { without: CUTS[2][0] });
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const port = await freePort();
  await assert.rejects(build(root, port, undefined, repo), /reconcileBrowserAutoOpenTask.*is in 0 engine files/);
  assert.equal(existsSync(path.join(root, 'patched.ok')), false);
  await assert.rejects(run(root, port, 1, repo), /was not cut/);
  // The same when the line shows up in a second engine file.
  writeFileSync(path.join(repo, 'server', 'install', 'held.js'), `/*\n${CUTS.map(([from]) => from).join('\n')}\n*/\n`);
  writeFileSync(path.join(repo, 'server', 'twice.js'), `// ${CUTS[0][0]}\n`);
  await assert.rejects(build(root, port, undefined, repo), /is in 2 engine files/);
  await assert.rejects(run(root, port, 1, repo), /was not cut/);
});

test('a copy runs in folders of its own, answers the marker, and ends with its process when the stop file appears', async (t) => {
  const { repo, root } = fakeRepo(t);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const port = await freePort();
  await build(root, port, undefined, repo);
  const running = run(root, port, 2, repo);
  try {
    await mustBeSideCopy(port, 30_000);
    await assert.rejects(build(root, port, undefined, repo), /in use/);
    const folders = readFileSync(path.join(root, 'server', 'data', 'home.txt'), 'utf8').split('\n');
    assert.equal(folders.length, 5);
    for (const folder of folders) assert.ok(folder.startsWith(root + path.sep), folder);
  } finally {
    writeFileSync(path.join(root, 'stop'), '');
  }
  assert.equal(await running, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}${MARKER_ADDRESS}`));
  assert.equal(existsSync(path.join(root, 'stop')), false);
});

test('the page check is told no about a server that is not a cut copy, and about a port nothing answers on', async (t) => {
  const plain = createServer((req, res) => { res.writeHead(req.url === MARKER_ADDRESS ? 404 : 200); res.end('{}'); });
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  t.after(() => plain.close());
  await assert.rejects(mustBeSideCopy(plain.address().port, 5000), /not a cut copy/);
  const other = createServer((req, res) => { res.writeHead(200); res.end(JSON.stringify({ sideCopy: true, port: 1 })); });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  t.after(() => other.close());
  await assert.rejects(mustBeSideCopy(other.address().port, 5000), /not a cut copy/);
  await assert.rejects(mustBeSideCopy(await freePort(), 1200), /nothing answers/);
  await assert.rejects(mustBeSideCopy(3030, 1200), /installed app/);
});

test('a recording that differs only by the resize notice is made again, twice at most, and says so', async () => {
  const notice = `desktop widgets 2: new page error: ${RESIZE_NOTICE}`;
  const other = 'dashboard: new on window: Leak';
  assert.equal(onlyResizeNotice([notice, `menu: new console error: ${RESIZE_NOTICE}`]), true);
  assert.equal(onlyResizeNotice([]), false, 'nothing differs: nothing to record again');
  assert.equal(onlyResizeNotice([notice, other]), false, 'another difference stays a difference');
  assert.equal(onlyResizeNotice([`dashboard: new failed request: /x?${RESIZE_NOTICE}`]), false, 'only as an error of the page');
  // `answers`: what each compare finds, in order; `codes`: how each recording ends.
  const tried = async (answers, codes = []) => {
    const said = [];
    let recorded = 0;
    const found = await recordUntilSame({ recordOnce: async () => { recorded += 1; return codes[recorded - 1] ?? 0; }, compare: () => answers.shift() ?? [], say: (line) => said.push(line) });
    return { ...found, recorded, said };
  };
  assert.deepEqual(await tried([[]]), { code: 0, again: 0, problems: [], recorded: 1, said: [] });
  const once = await tried([[notice], []]);
  assert.deepEqual([once.code, once.again, once.problems, once.recorded], [0, 1, [], 2]);
  assert.match(once.said[0], /^Recorded again \(1 of 2 at most\): the only difference was the notice "ResizeObserver loop completed with undelivered notifications\." on desktop widgets 2, which an engine gives on some runs and not on others\.$/);
  const never = await tried([[notice], [notice], [notice], []]);
  assert.deepEqual([never.again, never.problems, never.recorded, never.said.length], [2, [notice], 3, 2], 'the third time it is reported as it is');
  assert.deepEqual((await tried([[notice, other]])).recorded, 1, 'a real difference is not recorded away');
  const real = await tried([[notice], [other]]);
  assert.deepEqual([real.again, real.problems], [1, [other]], 'what the second recording shows is what is reported');
  assert.deepEqual(await tried([[notice]], [0, 1]), { code: 1, again: 1, problems: [], recorded: 2, said: ['Recorded again (1 of 2 at most): the only difference was the notice "ResizeObserver loop completed with undelivered notifications." on desktop widgets 2, which an engine gives on some runs and not on others.'] });
  assert.deepEqual((await tried([[notice]], [1])).recorded, 1, 'a recording that failed is not compared');
});
