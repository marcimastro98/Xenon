// The integrations' tools (OBS, Twitch, YouTube, Streamer.bot, Spotify, Home
// Assistant, Discord voice) reach Bit by voice as well as in the chat: one
// builder, used by the chat turn and by Voice Live, and every tool it declares
// is dispatched by executeAiTool (the path Voice Live calls).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('chat and Voice Live share one builder for the integration tools', () => {
  assert.match(src, /async function addIntegrationAiFunctions\(fns\)/);
  assert.match(src, /= await addIntegrationAiFunctions\(AI_FUNCTIONS\);/, 'the chat turn');
  assert.match(src, /const linked = await addIntegrationAiFunctions\(tools\);[\s\S]{0,200}linked\.streamingText \+ linked\.integrationsText/, 'Voice Live, with the lines that name them');
});

test('every tool the builder declares is dispatched by executeAiTool', () => {
  const start = src.indexOf('async function addIntegrationAiFunctions');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const names = [...body.matchAll(/AI_FUNCTIONS\.push\(\{ name: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['discord_voice', 'home_assistant', 'obs_control', 'spotify_control', 'streamerbot_action', 'twitch_action', 'youtube_broadcast']);
  const exec = src.slice(src.indexOf('async function executeAiTool'));
  for (const n of names) assert.ok(exec.includes(`fnName === '${n}'`), n);
});
