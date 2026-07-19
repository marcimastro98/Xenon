import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const link = require('../claude-link.js');

const PORT = 3030;

// Each test gets its own fake ~/.claude and its own DATA_DIR, so nothing here
// can touch the developer's real Claude Code configuration.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-link-'));
  const cfg = path.join(root, 'claude');
  const data = path.join(root, 'data');
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = cfg;
  return {
    cfg, data,
    settingsFile: path.join(cfg, 'settings.json'),
    write: (obj) => fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(obj, null, 2)),
    read: () => JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8')),
    cleanup: () => { delete process.env.CLAUDE_CONFIG_DIR; fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('link writes the permission hook and the statusline', async () => {
  const s = sandbox();
  try {
    const st = await link.link(s.data, PORT);
    assert.equal(st.linked, true);

    const cfg = s.read();
    // Every lifecycle event we rely on is present, plus the blocking one.
    for (const ev of link.EVENT_HOOKS) assert.ok(Array.isArray(cfg.hooks[ev]), 'missing hook: ' + ev);
    const perm = cfg.hooks[link.PERMISSION_EVENT][0].hooks[0];
    assert.equal(perm.type, 'http');
    assert.equal(perm.url, `http://127.0.0.1:${PORT}/api/claude/permission`);
    assert.equal(perm.timeout, 600);
    assert.ok(perm.headers['X-Xenon-Bridge'].length >= 32);
    // No matcher → fires for every tool, which is what an approval panel needs.
    assert.equal(cfg.hooks[link.PERMISSION_EVENT][0].matcher, undefined);

    assert.equal(cfg.statusLine.type, 'command');
    assert.ok(cfg.statusLine.command.includes('claude-statusline.js'));
  } finally { s.cleanup(); }
});

test('an existing statusline is chained, not destroyed', async () => {
  const s = sandbox();
  try {
    s.write({ statusLine: { type: 'command', command: 'my-own-bar.sh', padding: 2 } });
    const st = await link.link(s.data, PORT);

    // Ours is installed…
    assert.ok(s.read().statusLine.command.includes('claude-statusline.js'));
    // …the user's padding is preserved…
    assert.equal(s.read().statusLine.padding, 2);
    // …and theirs is remembered so our script can run it.
    assert.equal(st.chained, 'my-own-bar.sh');
    const state = await link.readState(s.data);
    assert.equal(state.chained.command, 'my-own-bar.sh');
  } finally { s.cleanup(); }
});

test('the original settings are backed up before the first write', async () => {
  const s = sandbox();
  try {
    s.write({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } });
    await link.link(s.data, PORT);
    const backup = JSON.parse(fs.readFileSync(s.settingsFile + '.xenon-backup', 'utf8'));
    assert.equal(backup.model, 'opus');
    assert.equal(backup.hooks.Stop[0].hooks[0].command, 'mine.sh');
  } finally { s.cleanup(); }
});

test('the user\'s own hooks survive link and unlink', async () => {
  const s = sandbox();
  try {
    s.write({
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'notify-me.sh' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }],
      },
    });
    await link.link(s.data, PORT);

    const linked = s.read();
    // Ours was appended alongside theirs, not on top of it.
    assert.equal(linked.hooks.Stop.length, 2);
    assert.equal(linked.hooks.Stop[0].hooks[0].command, 'notify-me.sh');
    assert.equal(linked.hooks.PreToolUse[0].matcher, 'Bash');

    await link.unlink(s.data, PORT);
    const after = s.read();
    assert.equal(after.model, 'opus');
    assert.equal(after.hooks.Stop.length, 1);
    assert.equal(after.hooks.Stop[0].hooks[0].command, 'notify-me.sh');
    assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'audit.sh');
    assert.equal(after.statusLine, undefined);
  } finally { s.cleanup(); }
});

test('unlink restores the chained statusline verbatim', async () => {
  const s = sandbox();
  try {
    const original = { type: 'command', command: 'my-own-bar.sh', padding: 3 };
    s.write({ statusLine: original });
    await link.link(s.data, PORT);
    await link.unlink(s.data, PORT);
    assert.deepEqual(s.read().statusLine, original);
  } finally { s.cleanup(); }
});

test('relinking does not duplicate our hooks', async () => {
  const s = sandbox();
  try {
    await link.link(s.data, PORT);
    await link.link(s.data, PORT);
    await link.link(s.data, PORT);
    const cfg = s.read();
    assert.equal(cfg.hooks[link.PERMISSION_EVENT].length, 1);
    assert.equal(cfg.hooks.Stop.length, 1);
    // Our own script must never end up chained to itself.
    const state = await link.readState(s.data);
    assert.ok(!state.chained || !String(state.chained.command).includes('claude-statusline.js'));
  } finally { s.cleanup(); }
});

test('the bridge token is stable across relinks', async () => {
  const s = sandbox();
  try {
    const a = await link.ensureToken(s.data);
    await link.link(s.data, PORT);
    await link.unlink(s.data, PORT);
    const b = await link.ensureToken(s.data);
    assert.equal(a, b);
    assert.ok(a.length >= 32);
  } finally { s.cleanup(); }
});

test('link works when settings.json does not exist yet', async () => {
  const s = sandbox();
  try {
    const st = await link.link(s.data, PORT);
    assert.equal(st.linked, true);
    assert.ok(fs.existsSync(s.settingsFile));
    // Nothing to back up, so no backup file is invented.
    assert.equal(fs.existsSync(s.settingsFile + '.xenon-backup'), false);
  } finally { s.cleanup(); }
});

test('status reports an unlinked config honestly', async () => {
  const s = sandbox();
  try {
    s.write({ statusLine: { type: 'command', command: 'theirs.sh' } });
    const st = await link.status(s.data, PORT);
    assert.equal(st.linked, false);
    assert.equal(st.hookCount, 0);
    assert.equal(st.statusLine, 'foreign');
  } finally { s.cleanup(); }
});

test('stripOurHooks removes a stale entry from a different port', () => {
  const hooks = {
    Stop: [
      { hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/api/claude/event' }] },
      { hooks: [{ type: 'command', command: 'keep.sh' }] },
    ],
  };
  const out = link.stripOurHooks(hooks, PORT);
  assert.equal(out.Stop.length, 1);
  assert.equal(out.Stop[0].hooks[0].command, 'keep.sh');
});

test('a foreign http hook to another local service is left alone', () => {
  const hooks = { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:8080/their/webhook' }] }] };
  const out = link.stripOurHooks(hooks, PORT);
  assert.equal(out.Stop.length, 1);
});
