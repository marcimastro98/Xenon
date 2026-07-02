import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const dc = require('../discord-rpc.js');
const reg = require('../actions/registry.js');
const { validateAction } = require('../js/deck-actions.js');

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('isSnowflake accepts channel ids, rejects junk', () => {
  assert.equal(dc.isSnowflake('199737254929760257'), true);
  assert.equal(dc.isSnowflake('12345'), true);
  assert.equal(dc.isSnowflake(''), false);
  assert.equal(dc.isSnowflake('abc'), false);
  assert.equal(dc.isSnowflake('123; rm -rf'), false);
  assert.equal(dc.isSnowflake(null), false);
  assert.equal(dc.isSnowflake('1'.repeat(30)), false);   // too long
});

test('toggleValue honours explicit words and flips on toggle', () => {
  assert.equal(dc.toggleValue('mute', false, 'mute', 'unmute'), true);
  assert.equal(dc.toggleValue('unmute', true, 'mute', 'unmute'), false);
  assert.equal(dc.toggleValue('toggle', false, 'mute', 'unmute'), true);
  assert.equal(dc.toggleValue('toggle', true, 'mute', 'unmute'), false);
  assert.equal(dc.toggleValue('deafen', false, 'deafen', 'undeafen'), true);
});

test('nextPttType maps modes and flips on toggle', () => {
  assert.equal(dc.nextPttType('ptt'), 'PUSH_TO_TALK');
  assert.equal(dc.nextPttType('vad'), 'VOICE_ACTIVITY');
  assert.equal(dc.nextPttType('toggle', 'PUSH_TO_TALK'), 'VOICE_ACTIVITY');
  assert.equal(dc.nextPttType('toggle', 'VOICE_ACTIVITY'), 'PUSH_TO_TALK');
  assert.equal(dc.nextPttType('toggle', undefined), 'PUSH_TO_TALK');
});

test('nudgedVolume steps by 10 and clamps to range', () => {
  assert.equal(dc.nudgedVolume(50, 'up', 100), 60);
  assert.equal(dc.nudgedVolume(50, 'down', 100), 40);
  assert.equal(dc.nudgedVolume(95, 'up', 100), 100);      // clamp high
  assert.equal(dc.nudgedVolume(5, 'down', 100), 0);       // clamp low
  assert.equal(dc.nudgedVolume(195, 'up', 200), 200);     // output range
  assert.equal(dc.nudgedVolume(NaN, 'up', 100), 10);      // undefined current → 0-based
});

test('encodeFrame / createDecoder round-trip, incl. split across chunks', () => {
  const a = dc.encodeFrame(0, { v: 1, client_id: 'x' });
  const b = dc.encodeFrame(1, { cmd: 'AUTHENTICATE', nonce: 'n1' });
  const got = [];
  const push = dc.createDecoder((op, data) => got.push([op, data]));
  // Feed the two frames chopped at an arbitrary byte to exercise buffering.
  const all = Buffer.concat([a, b]);
  push(all.subarray(0, 5));
  push(all.subarray(5, a.length + 3));
  push(all.subarray(a.length + 3));
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], [0, { v: 1, client_id: 'x' }]);
  assert.deepEqual(got[1], [1, { cmd: 'AUTHENTICATE', nonce: 'n1' }]);
});

// ── Registry dispatch ────────────────────────────────────────────────────────

test('registry routes every discord action through deps.discord', async () => {
  const seen = [];
  const deps = { discord: (action) => { seen.push(action); return Promise.resolve({ ok: true }); } };
  const r = reg.createRegistry(deps);
  assert.deepEqual(await r.run({ type: 'discordMute', mode: 'mute' }), { ok: true });
  assert.deepEqual(await r.run({ type: 'discordDeafen', mode: 'toggle' }), { ok: true });
  assert.deepEqual(await r.run({ type: 'discordJoin', channel: '199737254929760257' }), { ok: true });
  assert.deepEqual(await r.run({ type: 'discordLeave' }), { ok: true });
  assert.deepEqual(await r.run({ type: 'discordAudioToggle', feature: 'noise_suppression' }), { ok: true });
  // The dispatcher forwards the VALIDATED action (mode coerced, channel kept).
  assert.equal(seen.length, 5);
  assert.equal(seen[0].type, 'discordMute');
  assert.equal(seen[2].channel, '199737254929760257');
});

test('registry degrades cleanly when discord dep is missing or fails', async () => {
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'discordMute', mode: 'mute' }), { ok: false, error: 'discord_unavailable' });
  const failing = { discord: () => Promise.resolve({ ok: false, error: 'not_connected' }) };
  assert.deepEqual(await reg.createRegistry(failing).run({ type: 'discordJoin', channel: '1' }), { ok: false, error: 'not_connected' });
});

test('validateAction coerces discord params to the catalog', () => {
  // Unknown mode → first option; unknown feature → first option.
  assert.equal(validateAction({ type: 'discordPtt', mode: 'bogus' }).mode, 'toggle');
  assert.equal(validateAction({ type: 'discordAudioToggle', feature: 'evil' }).feature, 'noise_suppression');
  // Channel is free text (validated as a snowflake later in the provider), capped.
  assert.equal(validateAction({ type: 'discordJoin', channel: '199737254929760257' }).channel, '199737254929760257');
});

// ── Provider (mocked pipe) ───────────────────────────────────────────────────

// A join with a non-snowflake channel is rejected BEFORE any socket is opened.
test('provider.runAction rejects a bad channel without connecting', async () => {
  let connected = false;
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(os.tmpdir(), 'no-such-tokens.json'),
    connect: () => { connected = true; return Promise.reject(new Error('should not connect')); },
  });
  assert.deepEqual(await p.runAction({ type: 'discordJoin', channel: 'not-an-id' }), { ok: false, error: 'bad_channel' });
  assert.equal(connected, false);
});

// A minimal fake IPC pipe that speaks the handshake→READY→AUTHENTICATE dance and
// answers each command with a success frame echoing its nonce.
function fakePipe(onCommand) {
  const sock = new EventEmitter();
  sock.destroy = () => {};
  sock.write = (buf) => {
    const op = buf.readInt32LE(0);
    const len = buf.readInt32LE(4);
    const msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
    queueMicrotask(() => {
      if (op === 0) { sock.emit('data', dc.encodeFrame(1, { cmd: 'DISPATCH', evt: 'READY', data: {} })); return; }
      if (op === 1 && msg.cmd === 'AUTHENTICATE') { sock.emit('data', dc.encodeFrame(1, { cmd: 'AUTHENTICATE', nonce: msg.nonce, data: {} })); return; }
      if (op === 1) { const data = onCommand ? onCommand(msg.cmd, msg.args) : {}; sock.emit('data', dc.encodeFrame(1, { cmd: msg.cmd, nonce: msg.nonce, data })); }
    });
    return true;
  };
  return sock;
}

test('provider.login reports discord_not_running when no pipe connects', async () => {
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(os.tmpdir(), 'no-such-tokens.json'),
    connect: () => Promise.reject(new Error('discord_not_running')),
  });
  assert.deepEqual(await p.login(), { ok: false, error: 'discord_not_running' });
});

test('provider.login needs both client id and secret', async () => {
  const p = dc.createDiscordProvider({ clientId: 'id', clientSecret: '', connect: () => Promise.reject(new Error('x')) });
  assert.equal(p.configured(), false);
  assert.deepEqual(await p.login(), { ok: false, error: 'no_client' });
});

test('provider.runAction drives the full handshake + SET over a mocked pipe', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000, username: 'me' } }));
  const sent = [];
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret', tokensFile,
    connect: () => Promise.resolve(fakePipe((cmd, args) => {
      sent.push([cmd, args]);
      if (cmd === 'GET_VOICE_SETTINGS') return { mute: false, mode: { type: 'VOICE_ACTIVITY' }, input: { volume: 50 } };
      return {};
    })),
  });
  // Explicit mute needs no GET (value is known) → one SET_VOICE_SETTINGS.
  assert.deepEqual(await p.runAction({ type: 'discordMute', mode: 'mute' }), { ok: true });
  const set = sent.find((s) => s[0] === 'SET_VOICE_SETTINGS');
  assert.deepEqual(set[1], { mute: true });
  // A toggle reads current state first, then flips it.
  sent.length = 0;
  assert.deepEqual(await p.runAction({ type: 'discordMute', mode: 'toggle' }), { ok: true });
  assert.ok(sent.some((s) => s[0] === 'GET_VOICE_SETTINGS'));
  assert.deepEqual(sent.find((s) => s[0] === 'SET_VOICE_SETTINGS')[1], { mute: true });
  p.close();
});

test('provider.voiceState reads settings + channel into a client-safe shape', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000, username: 'me' } }));
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret', tokensFile,
    connect: () => Promise.resolve(fakePipe((cmd) => {
      if (cmd === 'GET_VOICE_SETTINGS') {
        return {
          mute: true, deaf: false, mode: { type: 'PUSH_TO_TALK' },
          input: { volume: 62.5 }, output: { volume: 140.2 },
          noise_suppression: true, echo_cancellation: false, automatic_gain_control: false, qos: true,
        };
      }
      if (cmd === 'GET_SELECTED_VOICE_CHANNEL') return { id: '199737254929760257', name: 'General', type: 2 };
      return {};
    })),
  });
  const vs = await p.voiceState();
  assert.equal(vs.ok, true);
  assert.equal(vs.connected, true);
  assert.equal(vs.mute, true);
  assert.equal(vs.deaf, false);
  assert.equal(vs.mode, 'PUSH_TO_TALK');
  assert.equal(vs.inputVolume, 63);           // rounded
  assert.equal(vs.outputVolume, 140);
  assert.deepEqual(vs.features, { noise_suppression: true, echo_cancellation: false, automatic_gain_control: false, qos: true });
  assert.deepEqual(vs.channel, { id: '199737254929760257', name: 'General' });   // no token/guild leak
  p.close();
});

test('provider.voiceState degrades to { ok:false } when not connected', async () => {
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(os.tmpdir(), 'no-such-tokens.json'),
    connect: () => Promise.reject(new Error('discord_not_running')),
  });
  const vs = await p.voiceState();
  assert.equal(vs.ok, false);
  assert.ok(vs.error);
});

test('channelMembers maps voice_states to a client-safe member list', () => {
  const ch = {
    id: '1', name: 'General',
    voice_states: [
      { user: { id: '10', username: 'bob', global_name: 'Bob' }, nick: 'Bobby', voice_state: { self_mute: true } },
      { user: { id: '11', username: 'ann' }, voice_state: { deaf: true } },
      { nick: 'ghost' },                    // no user → skipped
    ],
  };
  const m = dc.channelMembers(ch);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], { id: '10', name: 'Bobby', mute: true, deaf: false, speaking: false });  // nick wins, self_mute → mute
  assert.deepEqual(m[1], { id: '11', name: 'ann', mute: false, deaf: true, speaking: false });
  assert.deepEqual(dc.channelMembers(null), []);
  assert.equal(dc.channelMembers({ voice_states: Array.from({ length: 80 }, (_, i) => ({ user: { id: String(i), username: 'u' + i } })) }).length, 50);  // capped
});

test('provider.voiceState includes the current channel members', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000, username: 'me' } }));
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret', tokensFile,
    connect: () => Promise.resolve(fakePipe((cmd) => {
      if (cmd === 'GET_VOICE_SETTINGS') return { mute: false, mode: { type: 'VOICE_ACTIVITY' } };
      if (cmd === 'GET_SELECTED_VOICE_CHANNEL') return {
        id: '199737254929760257', name: 'General', type: 2,
        voice_states: [{ user: { id: '900', username: 'alice' }, nick: 'Alice', voice_state: {} }],
      };
      return {};
    })),
  });
  const vs = await p.voiceState();
  assert.deepEqual(vs.channel, { id: '199737254929760257', name: 'General' });
  assert.equal(vs.members.length, 1);
  assert.equal(vs.members[0].name, 'Alice');
  assert.equal(vs.members[0].speaking, false);
  p.close();
});

test('provider.voiceRoster lists each voice channel with its current members', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000, username: 'me' } }));
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret', tokensFile,
    connect: () => Promise.resolve(fakePipe((cmd, args) => {
      if (cmd === 'GET_GUILDS') return { guilds: [{ id: 'g1', name: 'Server One' }] };
      if (cmd === 'GET_CHANNELS') return { channels: [
        { id: '100', name: 'General', type: 2 },   // voice
        { id: '101', name: 'text', type: 0 },       // text → ignored
        { id: '102', name: 'AFK', type: 2 },        // voice, empty
      ] };
      if (cmd === 'GET_CHANNEL') {
        if (args.channel_id === '100') return { id: '100', name: 'General', voice_states: [
          { user: { id: '900', username: 'alice' }, nick: 'Alice', voice_state: { self_mute: true } },
        ] };
        return { id: args.channel_id, name: 'AFK', voice_states: [] };
      }
      return {};
    })),
  });
  const r = await p.voiceRoster();
  assert.equal(r.ok, true);
  assert.equal(r.channels.length, 2);                 // only the two voice channels
  const general = r.channels.find((c) => c.id === '100');
  assert.equal(general.name, 'General');
  assert.equal(general.guild, 'Server One');
  assert.equal(general.members.length, 1);
  assert.deepEqual(general.members[0], { id: '900', name: 'Alice', mute: true, deaf: false, speaking: false });
  assert.deepEqual(r.channels.find((c) => c.id === '102').members, []);   // nobody inside
  p.close();
});

test('provider.voiceRoster degrades to { ok:false } when not connected', async () => {
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(os.tmpdir(), 'no-such-tokens.json'),
    connect: () => Promise.reject(new Error('discord_not_running')),
  });
  const r = await p.voiceRoster();
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('provider.watchVoice pushes state, then flips speaking live on a SPEAKING event', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000, username: 'me' } }));
  const sock = fakePipe((cmd) => {
    if (cmd === 'GET_VOICE_SETTINGS') return { mute: false, mode: { type: 'VOICE_ACTIVITY' } };
    if (cmd === 'GET_SELECTED_VOICE_CHANNEL') return {
      id: '111', name: 'General', type: 2,
      voice_states: [{ user: { id: '900', username: 'alice' }, nick: 'Alice', voice_state: {} }],
    };
    return {};                              // SUBSCRIBE/UNSUBSCRIBE acks
  });
  const p = dc.createDiscordProvider({ clientId: 'id', clientSecret: 'secret', tokensFile, connect: () => Promise.resolve(sock) });
  const states = [];
  const stop = p.watchVoice((s) => states.push(s));
  await new Promise((r) => setTimeout(r, 40));
  const first = states[states.length - 1];
  assert.equal(first.ok, true);
  assert.equal(first.channel.name, 'General');
  assert.equal(first.members[0].speaking, false);
  // A SPEAKING_START DISPATCH (no nonce) flips the member without any refetch.
  sock.emit('data', dc.encodeFrame(1, { cmd: 'DISPATCH', evt: 'SPEAKING_START', data: { channel_id: '111', user_id: '900' } }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(states[states.length - 1].members[0].speaking, true);
  stop();
  p.close();
});
