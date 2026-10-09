'use strict';
// claude-history.js — the Claude tile's Chats face: list the chats Claude Code
// keeps on disk and move chosen ones to the Recycle Bin/Trash. Pinned here:
// titles come from the file (a /rename beats Claude's own title, which beats the
// first prompt), ids never become paths unless the module's own listing has
// them, a chat in use is refused, and only paths under the config dir reach the
// trash, companions included.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionStore, _internal } = require('../claude-history.js');

const OLD = Date.now() - 24 * 3600 * 1000;
const line = (o) => JSON.stringify(o) + '\n';

async function fixture() {
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'xenon-claude-history-'));
  const projects = path.join(config, 'projects');
  const proj = path.join(projects, 'C--work-alpha');
  await fs.mkdir(proj, { recursive: true });
  const write = async (id, lines) => {
    const file = path.join(proj, id + '.jsonl');
    await fs.writeFile(file, lines.join(''));
    await fs.utimes(file, OLD / 1000, OLD / 1000);
    return file;
  };
  await write('aaa-1', [
    line({ type: 'user', cwd: 'C:\\work\\alpha', message: { content: 'fix the login bug' } }),
    line({ type: 'ai-title', aiTitle: 'Login bug fix' }),
    line({ type: 'custom-title', customTitle: 'My login work' }),
  ]);
  await write('bbb-2', [
    line({ type: 'user', cwd: 'C:\\work\\alpha', message: { content: [{ type: 'text', text: 'add a dark theme' }] } }),
    line({ type: 'ai-title', aiTitle: 'Dark theme' }),
  ]);
  await write('ccc-3', [line({ type: 'user', cwd: 'C:\\work\\alpha', message: { content: 'just a prompt' } })]);
  await fs.writeFile(path.join(proj, 'not a session!.jsonl'), '');
  // Companions of aaa-1: subagents next to the transcript, and the per-session
  // folders under the config dir.
  await fs.mkdir(path.join(proj, 'aaa-1', 'subagents'), { recursive: true });
  await fs.writeFile(path.join(proj, 'aaa-1', 'subagents', 'a.jsonl'), 'x'.repeat(100));
  await fs.mkdir(path.join(config, 'file-history', 'aaa-1'), { recursive: true });
  await fs.writeFile(path.join(config, 'file-history', 'aaa-1', 'v1'), 'y'.repeat(50));
  return { config, projects, proj };
}

function fakeTrash(calls) {
  return async (root, paths) => {
    calls.push({ root, paths });
    for (const p of paths) await fs.rm(p, { recursive: true, force: true });
    return { ok: true, moved: paths };
  };
}

test('titles: /rename beats the AI title, which beats the first prompt', async () => {
  const fx = await fixture();
  const store = createSessionStore({ projectsDir: () => fx.projects, trash: fakeTrash([]) });
  const r = await store.list();
  assert.equal(r.ok, true);
  const by = Object.fromEntries(r.sessions.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(by).sort(), ['aaa-1', 'bbb-2', 'ccc-3']);
  assert.equal(by['aaa-1'].title, 'My login work');
  assert.equal(by['bbb-2'].title, 'Dark theme');
  assert.equal(by['ccc-3'].title, 'just a prompt');
  assert.equal(by['aaa-1'].project, 'alpha');
  assert.ok(by['aaa-1'].bytes > 150, 'companion folders count toward the size');
  assert.equal(by['aaa-1'].busy, false);
  for (const s of r.sessions) assert.equal('file' in s || 'path' in s, false, 'no path on the wire');
});

test('remove: moves the transcript and its companions, all under the config dir', async () => {
  const fx = await fixture();
  const calls = [];
  const store = createSessionStore({ projectsDir: () => fx.projects, trash: fakeTrash(calls) });
  const r = await store.remove(['aaa-1']);
  assert.deepEqual(r.removed, ['aaa-1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, fx.config);
  assert.equal(calls[0].paths.length, 3);
  for (const p of calls[0].paths) assert.ok(p.startsWith(fx.config + path.sep));
  const left = (await store.list()).sessions.map((s) => s.id).sort();
  assert.deepEqual(left, ['bbb-2', 'ccc-3']);
});

test('remove: refuses bad ids, unknown ids and chats in use', async () => {
  const fx = await fixture();
  const calls = [];
  const store = createSessionStore({
    projectsDir: () => fx.projects, trash: fakeTrash(calls), liveIds: () => new Set(['bbb-2']),
  });
  assert.equal((await store.remove(['../../etc', 'a/b', ''])).error, 'bad_request');
  assert.equal((await store.remove('aaa-1')).error, 'bad_request');
  const r = await store.remove(['bbb-2', 'zzz-9']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.refused.map((x) => x.reason).sort(), ['busy', 'not_found']);
  assert.equal(calls.length, 0, 'nothing reached the trash');

  // Written moments ago counts as in use even when the bridge does not know it.
  await fs.utimes(path.join(fx.proj, 'ccc-3.jsonl'), new Date(), new Date());
  const fresh = await store.remove(['ccc-3']);
  assert.deepEqual(fresh.refused, [{ id: 'ccc-3', reason: 'busy' }]);
});

test('remove: a file the trash did not move is reported, not claimed', async () => {
  const fx = await fixture();
  const store = createSessionStore({
    projectsDir: () => fx.projects, trash: async () => ({ ok: false, moved: [] }),
  });
  const r = await store.remove(['bbb-2']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.refused, [{ id: 'bbb-2', reason: 'not_moved' }]);
});

test('missing projects dir lists nothing and never throws', async () => {
  const store = createSessionStore({ projectsDir: () => path.join(os.tmpdir(), 'xenon-no-such-dir-' + process.pid), trash: fakeTrash([]) });
  const r = await store.list();
  assert.deepEqual([r.ok, r.sessions.length], [true, 0]);
});

test('oneLine flattens control characters and clamps', () => {
  assert.equal(_internal.oneLine('a\nb\u0007c   d', 100), 'a b c d');
  assert.equal(_internal.oneLine('x'.repeat(500), 10).length, 10);
});

test('live titles answer from memory, read in the background and fire onChange once', async () => {
  const fx = await fixture();
  let t = 1000;
  const store = createSessionStore({ projectsDir: () => fx.projects, trash: fakeTrash([]), now: () => t });
  let changes = 0;
  const onChange = () => { changes++; };
  assert.deepEqual(store.titles(['aaa-1', 'ccc-3', '../evil'], onChange), {}, 'first ask has nothing cached');
  for (let i = 0; i < 20 && !changes; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(changes, 1);
  assert.deepEqual(store.titles(['aaa-1', 'ccc-3'], onChange), { 'aaa-1': 'My login work', 'ccc-3': 'just a prompt' });
  // A recheck of unchanged files does not fire again.
  t += _internal.TITLE_RECHECK_MS;
  store.titles(['aaa-1'], onChange);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(changes, 1);
});
