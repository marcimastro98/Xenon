import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Regression tests for the shared OAuth token store (stream-common.js): the
// old patchCreds did its read-modify-write outside any lock, so two providers
// refreshing tokens in the same stream-tokens.json at the same moment could
// silently drop each other's freshly-refreshed token (→ random logouts).
const require = createRequire(import.meta.url);
const { createTokenStore, makeCredsNormalizer } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'stream-common.js'));

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'xenon-tok-'));
}

const normalize = makeCredsNormalizer({});

test('patchCreds persists a provider patch and updates the cache', async () => {
  const dir = freshDir();
  try {
    const tokensFile = join(dir, 'stream-tokens.json');
    const store = createTokenStore({ tokensFile, storeKey: 'twitch', normalize });
    await store.patchCreds({ accessToken: 'at', refreshToken: 'rt', expiresAt: 123 });
    const onDisk = JSON.parse(readFileSync(tokensFile, 'utf8'));
    assert.equal(onDisk.twitch.accessToken, 'at');
    assert.equal(onDisk.twitch.refreshToken, 'rt');
    assert.equal((await store.creds()).accessToken, 'at');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent patches from different providers never lose each other', async () => {
  const dir = freshDir();
  try {
    const tokensFile = join(dir, 'stream-tokens.json');
    const providers = ['twitch', 'youtube', 'spotify', 'discord'].map((key) =>
      createTokenStore({ tokensFile, storeKey: key, normalize }));
    await Promise.all(providers.map((p, i) =>
      p.patchCreds({ accessToken: `at-${i}`, refreshToken: `rt-${i}` })));
    const onDisk = JSON.parse(readFileSync(tokensFile, 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['discord', 'spotify', 'twitch', 'youtube']);
    assert.equal(onDisk.twitch.refreshToken, 'rt-0');
    assert.equal(onDisk.discord.refreshToken, 'rt-3');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt token file is replaced, not fatal', async () => {
  const dir = freshDir();
  try {
    const tokensFile = join(dir, 'stream-tokens.json');
    const store = createTokenStore({ tokensFile, storeKey: 'spotify', normalize });
    const fs = await import('node:fs');
    fs.writeFileSync(tokensFile, '{not json');
    await store.patchCreds({ accessToken: 'at' });
    const onDisk = JSON.parse(readFileSync(tokensFile, 'utf8'));
    assert.equal(onDisk.spotify.accessToken, 'at');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
