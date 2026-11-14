// The accounts of the streaming pages and the connection to Discord are made where the engine
// loads and made again when the person saves new app keys. Both times it is the same two
// functions (server/streaming/make-providers.js, server/discord/make-provider.js): written
// twice, the two copies could drift, and keys saved in Settings would count differently from
// the same keys after a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { declarationSource, engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { makeStreamProviders } = require('../streaming/make-providers.js');
const { streams } = require('../streaming/providers.js');
const { makeDiscordProvider } = require('../discord/make-provider.js');
const { discordLink } = require('../discord/link.js');

const IDS = { TWITCH_CLIENT_ID: 'test-twitch-id', YOUTUBE_CLIENT_ID: 'test-youtube-id', YOUTUBE_CLIENT_SECRET: 'test-youtube-secret',
  SPOTIFY_CLIENT_ID: 'test-spotify-id', DISCORD_CLIENT_ID: '100000000000000001', DISCORD_CLIENT_SECRET: 'test-discord-secret' };

// Runs `work` with invented app ids in the environment, where an id is read first, and takes them out again.
function withIds(work) {
  const before = Object.fromEntries(Object.keys(IDS).map((name) => [name, process.env[name]]));
  Object.assign(process.env, IDS);
  try { return work(); } finally {
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

test('the engine makes the accounts nowhere but in the two functions', () => {
  const engine = engineSource();
  for (const maker of ['createTwitchProvider', 'createYouTubeProvider', 'createSpotifyProvider', 'createDiscordProvider']) {
    assert.ok(!engine.includes(`${maker}(`), `${maker} is not called in the engine's own text`);
  }
  const made = [readFileSync(new URL('../streaming/make-providers.js', import.meta.url), 'utf8'), readFileSync(new URL('../discord/make-provider.js', import.meta.url), 'utf8')].join('\n');
  for (const maker of ['createTwitchProvider', 'createYouTubeProvider', 'createSpotifyProvider', 'createDiscordProvider']) {
    assert.equal(made.split(`${maker}(`).length - 1, 1, `${maker} is called once`);
  }
  assert.equal(engine.split('makeStreamProviders();').length - 1, 2, 'where the engine loads, and after a save of the keys');
  assert.equal(engine.split('makeDiscordProvider();').length - 1, 2, 'where the engine loads, and after a save of the keys');
});

test('a save of the keys writes the file first, then makes the accounts again, and closes the old Discord connection before the new one', () => {
  const save = declarationSource('saveStreamConfig');
  // The text handed out names the connection as the engine named it before it was shared by require: discordRpc.
  const order = ['await writeFileAtomic(STREAM_CONFIG_FILE', 'makeStreamProviders();', 'stopDiscordWatch();', 'discordRpc.close();', 'makeDiscordProvider();', 'refreshDiscordWatch();']
    .map((words) => save.indexOf(words));
  assert.ok(order.every((at) => at !== -1), 'every step is there');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in this order');
});

test('each call makes new accounts with the ids of that moment, and contacts nobody', async () => {
  await withIds(async () => {
    makeStreamProviders();
    makeDiscordProvider();
    const first = [streams.twitch, streams.youtube, streams.spotify, discordLink.rpc];
    assert.deepEqual(first.map((account) => account.configured()), [true, true, true, true]);
    makeStreamProviders();
    makeDiscordProvider();
    const second = [streams.twitch, streams.youtube, streams.spotify, discordLink.rpc];
    second.forEach((account, index) => assert.notEqual(account, first[index], 'a new object each time'));
    assert.deepEqual(second.map((account) => account.configured()), [true, true, true, true]);
    for (const account of [...first, discordLink.rpc]) if (typeof account.close === 'function') account.close();
  });
});
