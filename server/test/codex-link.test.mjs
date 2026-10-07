'use strict';
// codex-link.js — Xenon's hooks in the user's Codex hooks.json.
// What these pin, in order of how much it would cost the user to get wrong:
// a file we cannot parse is never replaced; the user's own hooks survive and
// keep their POSITION (Codex keys trust on it); a relink that changes nothing
// writes nothing (a rewrite costs a re-trust); unlink removes exactly ours.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const link = require('../codex-link.js');

async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xenon-codex-link-'));
  const home = path.join(root, 'codex');
  const data = path.join(root, 'data');
  await fs.mkdir(data, { recursive: true });
  process.env.CODEX_HOME = home;
  return { root, home, data, file: path.join(home, 'hooks.json') };
}
const read = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));
const USER_HOOK = { type: 'command', command: 'python3 ~/.codex/hooks/notes.py', statusMessage: 'Loading notes' };

test('hookCommand: cmd /C form on Windows, single-quoted on POSIX, spaces and accents survive', () => {
  assert.equal(
    link.hookCommand('win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\x\\Marci Progetti\\città\\server\\codex-hook.js', 'permission'),
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\Marci Progetti\\città\\server\\codex-hook.js" permission');
  assert.equal(
    link.hookCommand('darwin', '/opt/homebrew/bin/node', "/Users/o'neil/Xenon App/server/codex-hook.js", 'event'),
    "'/opt/homebrew/bin/node' '/Users/o'\\''neil/Xenon App/server/codex-hook.js' event");
});

test('link into a missing file creates exactly our five hooks; status is complete', async () => {
  const s = await sandbox();
  const st = await link.link(s.data, 3030);
  assert.equal(st.complete, true);
  assert.equal(st.linked, true);
  const j = await read(s.file);
  assert.deepEqual(Object.keys(j.hooks).sort(), ['PermissionRequest', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  const p = j.hooks.PermissionRequest[0].hooks[0];
  assert.equal(p.type, 'command');
  assert.equal(p.timeout, 600);
  assert.equal(p.async, undefined, 'the approval hook must block');
  assert.match(p.command, /codex-hook\.js" permission$|codex-hook\.js' permission$/);
  assert.equal(j.hooks.SessionStart[0].hooks[0].async, true);
  assert.equal(JSON.stringify(j).includes('3030'), false, 'the port is never in the file');
  const state = await read(path.join(s.data, 'codex-bridge.json'));
  assert.equal(state.port, 3030);
  assert.ok(state.token.length >= 32);
  assert.equal(JSON.stringify(j).includes(state.token), false, 'the token is never in the file');
});

test('the user hooks survive, keep their position, and a no-op relink writes nothing', async () => {
  const s = await sandbox();
  await fs.mkdir(s.home, { recursive: true });
  const original = { description: 'mine', hooks: { SessionStart: [{ matcher: 'startup', hooks: [USER_HOOK] }], PreToolUse: [{ matcher: 'Bash', hooks: [USER_HOOK] }] } };
  const raw = JSON.stringify(original, null, 4);   // the user's own formatting
  await fs.writeFile(s.file, raw);
  await link.link(s.data, 3030);
  const j = await read(s.file);
  assert.equal(j.description, 'mine');
  assert.deepEqual(j.hooks.SessionStart[0], { matcher: 'startup', hooks: [USER_HOOK] }, 'user group stays first');
  assert.deepEqual(j.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.equal(await fs.readFile(s.file + link.BACKUP_SUFFIX, 'utf8'), raw, 'backup is the original, byte for byte');

  // Byte-identical relink: nothing is written, so Codex's trust is untouched.
  const before = await fs.readFile(s.file, 'utf8');
  const mtime = (await fs.stat(s.file)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await link.link(s.data, 4040);
  assert.equal(await fs.readFile(s.file, 'utf8'), before);
  assert.equal((await fs.stat(s.file)).mtimeMs, mtime);
  assert.equal((await read(path.join(s.data, 'codex-bridge.json'))).port, 4040, 'a port change lives in our state only');
});

test('an out-of-date handler is replaced where it stands, never moved', async () => {
  const s = await sandbox();
  await link.link(s.data, 3030);
  const j = await read(s.file);
  // The user adds their own group AFTER ours, then Node moves.
  j.hooks.PermissionRequest.push({ hooks: [USER_HOOK] });
  j.hooks.PermissionRequest[0].hooks[0].command = '"C:\\old\\node.exe" "C:\\old\\codex-hook.js" permission';
  await fs.writeFile(s.file, JSON.stringify(j, null, 2));
  const st = await link.status(s.data);
  assert.deepEqual(st.outdated, ['PermissionRequest']);
  assert.equal(st.complete, false);
  const r = await link.repairLink(s.data, 3030);
  assert.equal(r.repaired, true);
  assert.equal(r.needsRetrust, true);
  const after = await read(s.file);
  assert.match(after.hooks.PermissionRequest[0].hooks[0].command, /codex-hook\.js/);
  assert.notEqual(after.hooks.PermissionRequest[0].hooks[0].command, j.hooks.PermissionRequest[0].hooks[0].command);
  assert.deepEqual(after.hooks.PermissionRequest[1], { hooks: [USER_HOOK] }, 'the user group keeps index 1');
});

test('repair never links an install the user did not link', async () => {
  const s = await sandbox();
  const r = await link.repairLink(s.data, 3030);
  assert.equal(r.repaired, false);
  assert.equal(r.linked, false);
  await assert.rejects(fs.access(s.file));
});

test('a hooks.json we cannot parse is refused, not replaced', async () => {
  const s = await sandbox();
  await fs.mkdir(s.home, { recursive: true });
  await fs.writeFile(s.file, '{ "hooks": { oops');
  const r = await link.link(s.data, 3030);
  assert.equal(r.error, 'unparsable');
  assert.equal(await fs.readFile(s.file, 'utf8'), '{ "hooks": { oops');
  await fs.writeFile(s.file, '[1,2]');
  assert.equal((await link.link(s.data, 3030)).error, 'unparsable');
  assert.equal((await link.status(s.data)).unparsable, true);
});

test('duplicates of ours are collapsed into one, the first one wins', () => {
  const ours = link.ourHandler(link.PERMISSION);
  const file = { hooks: { PermissionRequest: [{ hooks: [ours] }, { hooks: [USER_HOOK, Object.assign({}, ours)] }] } };
  const next = link.withOurHooks(file);
  assert.deepEqual(next.hooks.PermissionRequest[0], { hooks: [ours] });
  assert.deepEqual(next.hooks.PermissionRequest[1], { hooks: [USER_HOOK] });
});

test('unlink removes exactly ours, deletes a file we created, keeps the token', async () => {
  const s = await sandbox();
  await link.link(s.data, 3030);
  const token = (await read(path.join(s.data, 'codex-bridge.json'))).token;
  const st = await link.unlink(s.data);
  assert.equal(st.linked, false);
  await assert.rejects(fs.access(s.file), 'the file was ours alone and is gone');
  assert.equal((await read(path.join(s.data, 'codex-bridge.json'))).token, token);

  const t = await sandbox();
  await fs.mkdir(t.home, { recursive: true });
  await fs.writeFile(t.file, JSON.stringify({ hooks: { Stop: [{ hooks: [USER_HOOK] }] } }));
  await link.link(t.data, 3030);
  await link.unlink(t.data);
  assert.deepEqual(await read(t.file), { hooks: { Stop: [{ hooks: [USER_HOOK] }] } });
});

test('CODEX_HOME is honoured', async () => {
  const s = await sandbox();
  assert.equal(link.hooksPath(), s.file);
  assert.equal(link.isOurCommand('"node" "C:\\x\\server\\codex-hook.js" event'), true);
  assert.equal(link.isOurCommand('python3 notes.py'), false);
});
