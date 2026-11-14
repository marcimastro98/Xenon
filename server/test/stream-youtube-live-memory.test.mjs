// What the YouTube provider remembers about the broadcast on air, at the two places that forget it
// and that no other test reaches: a broadcast that was cancelled, and a chat YouTube says is gone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { createYouTubeProvider } = require('../stream-youtube.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-yt-live-'));
after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

// A signed-in provider whose requests are answered by the first route whose text the address holds.
function connected(routes) {
  const file = path.join(TMP_DIR, `tokens-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ youtube: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, channel: 'C', channelId: 'UC' } }));
  const fetch = async (url) => {
    const address = String(url);
    const route = routes.find((entry) => address.includes(entry.match));
    if (!route) throw new Error(`unexpected fetch: ${address}`);
    route.calls.push(address);
    return { ok: route.status < 400, status: route.status, json: async () => route.json };
  };
  return createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: file, fetch });
}
const upcoming = { items: [{ id: 'B', status: { lifeCycleStatus: 'ready' }, snippet: { title: 'T', liveChatId: 'CHAT1' } }] };

test('a cancelled broadcast is forgotten: its chat is not asked for again', async () => {
  const chat = { match: '/liveChat/messages', status: 200, json: { nextPageToken: 'P', pollingIntervalMillis: 5000, items: [] }, calls: [] };
  const broadcasts = { match: '/liveBroadcasts', status: 200, json: upcoming, calls: [] };
  const provider = connected([chat, broadcasts]);

  assert.equal((await provider.chatMessages('')).ok, true);
  assert.equal(chat.calls.length, 1);
  assert.ok(chat.calls[0].includes('liveChatId=CHAT1'));

  assert.deepEqual(await provider.cancelBroadcast(), { ok: true });
  broadcasts.json = { items: [] };
  // Another page than the one just answered, so the answer held for the poll interval is not what comes back.
  assert.deepEqual(await provider.chatMessages('PAGE2'), { ok: false, error: 'no_chat' });
  assert.equal(chat.calls.length, 1, 'the chat of the cancelled broadcast was asked for again');
});

test('a chat YouTube says is gone is forgotten: the next poll looks for the broadcast again', async () => {
  const chat = { match: '/liveChat/messages', status: 403, json: { error: { errors: [{ reason: 'liveChatEnded' }] } }, calls: [] };
  const broadcasts = { match: '/liveBroadcasts', status: 200, json: upcoming, calls: [] };
  const provider = connected([chat, broadcasts]);

  assert.equal((await provider.chatMessages('')).ok, false);
  const looked = broadcasts.calls.length;
  assert.ok(looked >= 1);

  assert.equal((await provider.chatMessages('')).ok, false);
  assert.ok(broadcasts.calls.length > looked, 'the chat id that answered 403 was used again without looking for the broadcast');
});

test('a chat that fails for another reason keeps its id: the broadcast is not looked for again', async () => {
  const chat = { match: '/liveChat/messages', status: 500, json: {}, calls: [] };
  const broadcasts = { match: '/liveBroadcasts', status: 200, json: upcoming, calls: [] };
  const provider = connected([chat, broadcasts]);

  assert.equal((await provider.chatMessages('')).ok, false);
  const looked = broadcasts.calls.length;
  assert.equal((await provider.chatMessages('')).ok, false);
  assert.equal(broadcasts.calls.length, looked);
  assert.equal(chat.calls.length, 2);
});
