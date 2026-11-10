// A choice made in a tile on a layer page (Discord favourite, ChatGPT model, a
// lyrics option, the Notifications tile switches) was dropped: those pages never
// write the settings blob. Pinned here: the narrow POST /settings/tile takes only
// those fields and shapes, merges the notifications block, is guarded like the
// other PC-only writers, and the client helper uses it only on a layer page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TileSettings = require('../tile-settings.js');
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('only the allowlisted fields, in their shape', () => {
  assert.deepEqual(TileSettings.plan({ patch: { discordFavChannels: ['123'] } }), { patch: { discordFavChannels: ['123'] } });
  assert.ok(TileSettings.plan({ patch: { lyricsStage: true, lyricsOffsetMs: -300 } }).patch);
  assert.equal(TileSettings.plan({ patch: { theme: 'dark' } }).error, 'not_allowed');
  assert.equal(TileSettings.plan({ patch: { ai: { key: 'x' } } }).error, 'not_allowed');
  assert.equal(TileSettings.plan({ patch: { lyricsStage: 'yes' } }).error, 'bad_value');
  assert.equal(TileSettings.plan({ patch: { lyricsOffsetMs: Infinity } }).error, 'bad_value');
  assert.equal(TileSettings.plan({ patch: { discordFavChannels: 'a' } }).error, 'bad_value');
  assert.equal(TileSettings.plan({ patch: { windowsNotifications: { enabled: true, apps: [] } } }).error, 'bad_value');
  assert.equal(TileSettings.plan({ patch: {} }).error, 'bad_patch');
  assert.equal(TileSettings.plan({ patch: [] }).error, 'bad_patch');
  assert.equal(TileSettings.plan(null).error, 'bad_patch');
  assert.equal(TileSettings.plan({ patch: { discordFavChannels: Array(400).fill('x'.repeat(60)) } }).error, 'too_large');
});

test('the notifications block keeps what the tile did not send', () => {
  const cur = { windowsNotifications: { enabled: false, hide: true, toast: true, excluded: [{ id: 'a' }] }, lyricsStage: true };
  assert.deepEqual(TileSettings.apply(cur, { windowsNotifications: { enabled: true } }),
    { windowsNotifications: { enabled: true, hide: true, toast: true, excluded: [{ id: 'a' }] } });
  assert.deepEqual(TileSettings.apply(cur, { lyricsStage: false }), { lyricsStage: false });
});

test('the route writes under the lock with a rev, CSRF-guarded and denied to paired devices', () => {
  const src = read('server.js');
  assert.match(src, /const CSRF_MUTATION_PATHS = new Set\(\[[\s\S]{0,200}'\/settings\/tile',/);
  assert.match(src, /reqPath === '\/settings\/tile' && req\.method === 'POST'[\s\S]{0,300}saveTileSettings\(body\)/);
  assert.match(src, /async function saveTileSettings\(body\) \{[\s\S]{0,300}withHubSettingsLock[\s\S]{0,300}nextSettingsRev[\s\S]{0,200}broadcastSSE\('settings'/);
  assert.equal((read('remote-access.js').match(/'\/settings\/tile'/g) || []).length, 1);
});

function helper({ layer, fetchOk = true }) {
  const calls = { saved: 0, posts: [] };
  const ctx = {
    window: { location: { search: layer ? '?layer=overlay:' : '' } },
    document: {}, console: { warn() {} }, JSON,
    SERVER: 'http://127.0.0.1:3030',
    hubSettings: { lyricsStage: false, theme: 'dark' },
    saveHubSettings: () => { calls.saved++; },
    fetch: async (url, opts) => { calls.posts.push([url, JSON.parse(opts.body)]); return { ok: fetchOk, status: fetchOk ? 200 : 400 }; },
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/utils.js'), ctx);
  return { ctx, calls };
}

test('the dashboard saves the settings as before; a layer page sends only the fields', async () => {
  const dash = helper({ layer: false });
  assert.equal(await vm.runInContext('saveTileSetting({ lyricsStage: true })', dash.ctx), true);
  assert.equal(dash.calls.saved, 1);
  assert.equal(dash.calls.posts.length, 0);

  const lay = helper({ layer: true });
  assert.equal(await vm.runInContext('saveTileSetting({ lyricsStage: true })', lay.ctx), true);
  assert.equal(lay.calls.saved, 0, 'never the whole blob from a layer page');
  assert.deepEqual(JSON.parse(JSON.stringify(lay.calls.posts)), [['http://127.0.0.1:3030/settings/tile', { patch: { lyricsStage: true } }]]);
  assert.equal(vm.runInContext('hubSettings.lyricsStage', lay.ctx), true);
});

test('a refused save puts the old value back', async () => {
  const lay = helper({ layer: true, fetchOk: false });
  assert.equal(await vm.runInContext('saveTileSetting({ lyricsStage: true })', lay.ctx), false);
  assert.equal(vm.runInContext('hubSettings.lyricsStage', lay.ctx), false);
});

test('the tiles save their choices through the helper', () => {
  assert.match(read('js/discord-widget.js'), /saveTileSetting\(\{ discordFavChannels: next \}\)/);
  assert.match(read('js/discord-widget.js'), /saveTileSetting\(\{ discordCollapsedGuilds: next \}\)/);
  assert.match(read('js/chatgpt-widget.js'), /saveTileSetting\(\{ chatgptWidget: \{ model: m \} \}\)/);
  assert.match(read('js/lyrics-widget-options.js'), /saveTileSetting\(patch\)/);
  assert.match(read('js/notifications-widget.js'), /isLayerPage\(\) && typeof saveTileSetting === 'function'/);
});
