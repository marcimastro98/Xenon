import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { parseDockerSize, parseSystemDf, createDockerSource } = require('../devclean-docker.js');
const { createOllamaSource, sameModel } = require('../devclean-ollama.js');
const { createVscodeSource, workspaceTarget } = require('../devclean-vscode.js');
const { parseLxss } = require('../devclean-vhdx.js');
const { createDevClean } = require('../devclean.js');
const { ID_RE } = require('../devclean-ids.js');

// Dev cleanup sources with injected runners: no docker, Ollama or editor needed.

test('docker: decimal sizes and system df lines', () => {
  assert.equal(parseDockerSize('5.3GB'), 5.3e9);
  assert.equal(parseDockerSize('812.4kB'), 812400);
  assert.equal(parseDockerSize('1.2GB (45%)'), 1.2e9);
  assert.equal(parseDockerSize('0B'), 0);
  assert.equal(parseDockerSize('nonsense'), 0);
  const df = parseSystemDf([
    '{"Active":"2","Reclaimable":"4.1GB (77%)","Size":"5.3GB","TotalCount":"10","Type":"Images"}',
    '{"Active":"0","Reclaimable":"1GB","Size":"1GB","TotalCount":"40","Type":"Build Cache"}',
    'garbage',
    '{"Active":"1","Reclaimable":"0B","Size":"2GB","TotalCount":"3","Type":"Local Volumes"}',
  ].join('\n'));
  assert.deepEqual(df.images, { count: 10, bytes: 5.3e9, reclaimable: 4.1e9 });
  assert.equal(df.buildCache.reclaimable, 1e9);
  assert.equal(df.volumes.bytes, 2e9);
});

test('docker: CLI absent vs daemon off, and only the two fixed prunes run', async () => {
  const missing = createDockerSource({ run: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  assert.deepEqual(await missing.overview(), { available: false, reason: 'not_installed' });
  const off = createDockerSource({ run: async () => { throw new Error('cannot connect'); } });
  assert.deepEqual(await off.overview(), { available: false, reason: 'not_running' });

  const calls = [];
  const src = createDockerSource({ run: async (f, args) => { calls.push(args.join(' ')); return { stdout: 'Total reclaimed space: 2GB' }; } });
  const res = await src.clean(['images', 'volumes', 'buildCache']);
  assert.deepEqual(calls, ['image prune -a -f', 'builder prune -f'], 'volumes are never pruned');
  assert.equal(res.freed, 4e9);
});

function fakeOllama(models, deleted) {
  return async (base, method, route, body) => {
    if (method === 'GET' && route === '/api/tags') return { ok: true, json: { models } };
    if (method === 'DELETE' && route === '/api/delete') { deleted.push(body.model); return { ok: true }; }
    return { ok: false };
  };
}

test('ollama: the active model and the crash fallback are never offered or removed', async () => {
  const deleted = [];
  const models = [
    { name: 'gemma4:12b', size: 8e9 }, { name: 'qwen2.5:3b', size: 2e9 }, { name: 'qwen3.5:35b-a3b', size: 22e9 },
  ];
  const src = createOllamaSource({ getSettings: () => ({ ollamaModel: 'gemma4:12b' }), request: fakeOllama(models, deleted) });
  const o = await src.overview();
  assert.equal(o.bytes, 32e9);
  assert.equal(o.reclaimable, 22e9);
  const byName = Object.fromEntries(o.items.map((it) => [it.name, it]));
  assert.equal(byName['gemma4:12b'].protected, true);
  assert.equal(byName['qwen2.5:3b'].protected, true);
  assert.ok(o.items.every((it) => ID_RE.test(it.id)));

  const res = await src.clean(o.items.map((it) => it.id));
  assert.deepEqual(deleted, ['qwen3.5:35b-a3b']);
  assert.equal(res.freed, 22e9);
  assert.equal(res.failed.length, 2);
});

test('ollama: an id survives a rebuilt overview, an unknown one removes nothing', async () => {
  const deleted = [];
  const req = fakeOllama([{ name: 'a:1', size: 1 }, { name: 'b:1', size: 2 }], deleted);
  const src = createOllamaSource({ getSettings: () => ({ ollamaModel: 'x:1' }), request: req });
  const first = await src.overview();
  const idA = first.items.find((it) => it.name === 'a:1').id;
  await src.overview();
  await src.clean([idA, 'mdeadbeefdead']);
  assert.deepEqual(deleted, ['a:1']);
  assert.ok(sameModel('qwen2.5:3b-instruct', 'qwen2.5:3b'));
  assert.ok(!sameModel('qwen2.5:32b', 'qwen2.5:3b'));
});

test('vscode: stale only when a local target is gone; remote and unplugged drives are kept', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'xenon-ws-'));
  const live = mkdtempSync(path.join(tmpdir(), 'xenon-proj-'));
  const mk = (name, json) => {
    const dir = path.join(root, name);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'state.vscdb'), 'x'.repeat(100));
    if (json) writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(json));
  };
  mk('alive', { folder: pathToFileURL(live).href });
  mk('gone', { folder: pathToFileURL(path.join(live, 'deleted-project')).href });
  mk('remote', { folder: 'vscode-remote://wsl+Ubuntu/home/me/app' });
  mk('empty', null);
  const trashed = [];
  const src = createVscodeSource({
    roots: [{ editor: 'Code', dir: root }],
    trash: async (r, paths) => { trashed.push(...paths); return { ok: true, moved: paths }; },
  });
  const o = await src.overview();
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].name, 'deleted-project');
  assert.equal(o.kept.workspaces, 3);
  const res = await src.clean([o.items[0].id]);
  assert.deepEqual(trashed, [path.join(root, 'gone')]);
  assert.equal(res.freed, 100 + JSON.stringify({ folder: pathToFileURL(path.join(live, 'deleted-project')).href }).length);
  assert.equal(workspaceTarget({ folder: 'untitled:x' }), null);
});

test('vhdx: parses reg.exe output into distro base paths', () => {
  const out = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{a}',
    '    BasePath    REG_SZ    \\\\?\\C:\\Users\\me\\AppData\\Local\\wsl\\{a}',
    '    DistributionName    REG_SZ    Ubuntu',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{b}',
    '    DistributionName    REG_SZ    Broken',
  ].join('\r\n');
  assert.deepEqual(parseLxss(out), [{ name: 'Ubuntu', basePath: 'C:\\Users\\me\\AppData\\Local\\wsl\\{a}' }]);
});

test('devclean: unknown sources and malformed ids are refused before any source runs', async () => {
  const dc = createDevClean({
    run: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
    getSettings: () => ({}), trash: async () => ({ moved: [] }), spawnDetached: () => {},
  });
  assert.deepEqual(await dc.runClean('vhdx', ['v0']), { ok: false, error: 'bad_source' });
  assert.deepEqual(await dc.runClean('ollama', ['../../etc', 42]), { ok: false, error: 'empty' });
  const sum = await dc.summary();
  assert.deepEqual(Object.keys(sum).sort(), ['docker', 'ollama', 'reclaimable', 'vhdx', 'vscode']);
  assert.equal(JSON.stringify(sum).includes('name'), false, 'the SDK summary carries no names');
});
