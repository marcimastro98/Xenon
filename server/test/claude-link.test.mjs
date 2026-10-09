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

// ── completeness and repair ──────────────────────────────────────────────────
// The shape an older Xenon wrote: seven lifecycle events on /event (Stop among
// them), the permission hook, no AskUserQuestion interceptor, no /turn-end. It
// counted as "linked", so questions never reached the tile.
function olderLink(token) {
  const h = (p, t) => ({ type: 'http', url: `http://127.0.0.1:${PORT}/api/claude/${p}`, timeout: t, headers: { 'X-Xenon-Bridge': token } });
  const hooks = {};
  for (const ev of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']) {
    hooks[ev] = [{ hooks: [h('event', 5)] }];
  }
  hooks.PermissionRequest = [{ hooks: [h('permission', 600)] }];
  return hooks;
}

test('a fresh link is complete', async () => {
  const s = sandbox();
  try {
    const st = await link.link(s.data, PORT);
    assert.equal(st.complete, true);
    assert.deepEqual(st.missing, []);
    assert.equal(st.outdated, 0);
    assert.equal(st.hookCount, st.expectedHooks);
  } finally { s.cleanup(); }
});

test('a link written by an older Xenon is linked but not complete', async () => {
  const s = sandbox();
  try {
    const token = await link.ensureToken(s.data);
    s.write({ hooks: olderLink(token), statusLine: { type: 'command', command: 'node "x/claude-statusline.js"' } });
    const st = await link.status(s.data, PORT);
    assert.equal(st.linked, true);
    assert.equal(st.complete, false);
    assert.ok(st.missing.includes('PreToolUse(AskUserQuestion) /question'));
    assert.ok(st.missing.includes('Stop /turn-end'));
    assert.equal(st.outdated, 1, 'Stop on /event is left over from the older set');
  } finally { s.cleanup(); }
});

test('a hook carrying an old token is not current', async () => {
  const s = sandbox();
  try {
    await link.link(s.data, PORT);
    const cfg = s.read();
    cfg.hooks.PermissionRequest[0].hooks[0].headers['X-Xenon-Bridge'] = 'f'.repeat(48);
    s.write(cfg);
    const st = await link.status(s.data, PORT);
    assert.equal(st.complete, false);
    assert.ok(st.missing.includes('PermissionRequest /permission'));
  } finally { s.cleanup(); }
});

test('repairLink brings an older link up to date and keeps the user\'s own hooks', async () => {
  const s = sandbox();
  try {
    const token = await link.ensureToken(s.data);
    const hooks = olderLink(token);
    hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] });
    s.write({ hooks, statusLine: { type: 'command', command: 'node "x/claude-statusline.js"' } });
    const r = await link.repairLink(s.data, PORT);
    assert.equal(r.repaired, true);
    assert.equal(r.complete, true);
    const cfg = s.read();
    const q = cfg.hooks.PreToolUse.find((g) => g.matcher === 'AskUserQuestion');
    assert.ok(q && q.hooks[0].url.endsWith('/api/claude/question'));
    assert.ok(cfg.hooks.Stop.some((g) => g.hooks.some((x) => x.url && x.url.endsWith('/api/claude/turn-end'))));
    assert.ok(!cfg.hooks.Stop.some((g) => g.hooks.some((x) => x.url && x.url.endsWith('/api/claude/event'))), 'the old Stop entry is gone');
    assert.ok(cfg.hooks.PreToolUse.some((g) => g.hooks.some((x) => x.command === 'my-guard.sh')), 'the user\'s own hook survives');
    // Idempotent: a second pass finds nothing to do.
    const again = await link.repairLink(s.data, PORT);
    assert.equal(again.repaired, false);
  } finally { s.cleanup(); }
});

test('repairLink never connects Claude Code on its own', async () => {
  const s = sandbox();
  try {
    s.write({ hooks: {}, permissions: { allow: [] } });
    const r = await link.repairLink(s.data, PORT);
    assert.equal(r.repaired, false);
    assert.equal(r.linked, false);
    assert.deepEqual(s.read().hooks, {});
  } finally { s.cleanup(); }
});

// ── the Xenon mod for Claude Code ───────────────────────────────────────────

const MOD_ID = 'xenon@xenon';

test('connecting also asks Claude Code for the mod', async () => {
  const s = sandbox();
  try {
    const st = await link.link(s.data, PORT);
    const cfg = s.read();
    assert.deepEqual(cfg.extraKnownMarketplaces.xenon, { source: { source: 'github', repo: 'marcimastro98/Xenon' } });
    assert.equal(cfg.enabledPlugins[MOD_ID], true);
    assert.equal(cfg.pluginConfigs[MOD_ID].options.approvals, false);
    assert.equal(st.modEnabled, true);
  } finally { s.cleanup(); }
});

test('the mod never overrides what the user already decided', async () => {
  const s = sandbox();
  try {
    s.write({
      extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'a/b' } } },
      enabledPlugins: { [MOD_ID]: false, 'x@y': true },
      pluginConfigs: { [MOD_ID]: { options: { approvals: true } } },
    });
    await link.link(s.data, PORT);
    const cfg = s.read();
    assert.equal(cfg.enabledPlugins[MOD_ID], false, 'a plugin they switched off stays off');
    assert.equal(cfg.pluginConfigs[MOD_ID].options.approvals, true, 'their option stays');
    assert.ok(cfg.extraKnownMarketplaces.other && cfg.extraKnownMarketplaces.xenon);
  } finally { s.cleanup(); }
});

test('a marketplace named xenon that is not ours is left alone', async () => {
  const s = sandbox();
  try {
    const theirs = { source: { source: 'github', repo: 'someone/else' } };
    s.write({ extraKnownMarketplaces: { xenon: theirs } });
    await link.link(s.data, PORT);
    const cfg = s.read();
    assert.deepEqual(cfg.extraKnownMarketplaces.xenon, theirs);
    assert.equal(cfg.enabledPlugins, undefined);
  } finally { s.cleanup(); }
});

test('a repair never adds the mod to a link that did not have it', async () => {
  const s = sandbox();
  try {
    await link.link(s.data, PORT, { mod: false });
    const cfg = s.read();
    delete cfg.hooks.Stop;                            // make the link incomplete
    s.write(cfg);
    const out = await link.repairLink(s.data, PORT);
    assert.equal(out.repaired, true);
    assert.equal(s.read().enabledPlugins, undefined);
  } finally { s.cleanup(); }
});

test('disconnecting removes the mod entries and keeps the user\'s own', async () => {
  const s = sandbox();
  try {
    s.write({
      extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'a/b' } } },
      enabledPlugins: { 'x@y': true },
    });
    await link.link(s.data, PORT);
    await link.unlink(s.data, PORT);
    const cfg = s.read();
    assert.deepEqual(Object.keys(cfg.extraKnownMarketplaces), ['other']);
    assert.deepEqual(cfg.enabledPlugins, { 'x@y': true });
    assert.equal(cfg.pluginConfigs, undefined);
  } finally { s.cleanup(); }
});
