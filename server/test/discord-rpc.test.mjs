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

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

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

test('isSoundId accepts default + guild sound ids, rejects junk', () => {
  assert.equal(dc.isSoundId('1'), true);                     // built-in default sound
  assert.equal(dc.isSoundId('199737254929760257'), true);    // guild snowflake
  assert.equal(dc.isSoundId(''), false);
  assert.equal(dc.isSoundId('abc'), false);
  assert.equal(dc.isSoundId('1; rm -rf'), false);
  assert.equal(dc.isSoundId(null), false);
});

test('parseSoundRef splits guild|sound and tolerates a bare id', () => {
  assert.deepEqual(dc.parseSoundRef('199737254929760257|123'), { guildId: '199737254929760257', soundId: '123' });
  assert.deepEqual(dc.parseSoundRef('|7'), { guildId: '', soundId: '7' });    // default sound, no guild
  assert.deepEqual(dc.parseSoundRef('42'), { guildId: '', soundId: '42' });   // bare id (forward-compat)
  assert.deepEqual(dc.parseSoundRef(null), { guildId: '', soundId: '' });
});

test('normNotification projects a NOTIFICATION_CREATE payload to the client-safe shape', () => {
  assert.deepEqual(dc.normNotification({
    title: 'marci (#general, Xenon)', body: 'ciao!',
    icon_url: 'https://cdn.discordapp.com/avatars/1/a.png', channel_id: '199737254929760257',
  }), {
    title: 'marci (#general, Xenon)', body: 'ciao!',
    icon: 'https://cdn.discordapp.com/avatars/1/a.png', channelId: '199737254929760257',
  });
});

test('normNotification caps lengths and drops payloads with no usable text', () => {
  const long = dc.normNotification({ title: 'T'.repeat(500), body: 'B'.repeat(500) });
  assert.equal(long.title.length, 140);
  assert.equal(long.body.length, 280);
  assert.equal(dc.normNotification({ icon_url: 'https://x/y.png', channel_id: '12345' }), null);
  assert.equal(dc.normNotification(null), null);
  assert.equal(dc.normNotification('junk'), null);
  // Non-string fields never leak through as "[object Object]".
  assert.equal(dc.normNotification({ title: { toString: () => 'x' } }), null);
});

test('normNotification enforces the https-only icon scheme and validates the channel id', () => {
  assert.equal(dc.normNotification({ title: 't', icon_url: 'javascript:alert(1)' }).icon, '');
  assert.equal(dc.normNotification({ title: 't', icon_url: 'data:image/png;base64,AAAA' }).icon, '');
  assert.equal(dc.normNotification({ title: 't', icon_url: 'http://cdn.discordapp.com/a.png' }).icon, '');
  assert.equal(dc.normNotification({ title: 't', icon_url: 'not a url' }).icon, '');
  assert.equal(dc.normNotification({ title: 't', icon_url: 'https://cdn.discordapp.com/a.png' }).icon, 'https://cdn.discordapp.com/a.png');
  assert.equal(dc.normNotification({ title: 't', channel_id: 'abc' }).channelId, '');
  assert.equal(dc.normNotification({ title: 't', channel_id: '199737254929760257' }).channelId, '199737254929760257');
});

test('normSound accepts sound_id|id, drops a non-snowflake guild, needs a numeric id', () => {
  assert.deepEqual(dc.normSound({ sound_id: '123', guild_id: '199737254929760257', name: 'Airhorn' }),
    { id: '123', guildId: '199737254929760257', name: 'Airhorn' });
  assert.deepEqual(dc.normSound({ id: '7', name: 'Quack' }), { id: '7', guildId: '', name: 'Quack' });   // default sound
  assert.deepEqual(dc.normSound({ sound_id: '9', guild_id: 'x' }), { id: '9', guildId: '', name: '9' }); // bad guild dropped, name → id
  assert.equal(dc.normSound({ name: 'no id' }), null);
  assert.equal(dc.normSound(null), null);
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

test('registry routes discordSoundboard through deps.discord', async () => {
  const seen = [];
  const deps = { discord: (action) => { seen.push(action); return Promise.resolve({ ok: true }); } };
  const r = reg.createRegistry(deps);
  assert.deepEqual(await r.run({ type: 'discordSoundboard', sound: '199737254929760257|123' }), { ok: true });
  assert.equal(seen[0].type, 'discordSoundboard');
  assert.equal(seen[0].sound, '199737254929760257|123');
});

test('validateAction keeps discordSoundboard sound ref as capped text', () => {
  assert.deepEqual(validateAction({ type: 'discordSoundboard', sound: '199737254929760257|123', junk: 1 }),
    { type: 'discordSoundboard', sound: '199737254929760257|123' });
  assert.equal(validateAction({ type: 'discordSoundboard' }).sound, '');   // missing → empty default
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

test('provider.login reports discord_pipe_busy distinctly (pipe exists but refused)', async () => {
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(os.tmpdir(), 'no-such-tokens.json'),
    connect: () => Promise.reject(new Error('discord_pipe_busy')),
  });
  assert.deepEqual(await p.login(), { ok: false, error: 'discord_pipe_busy' });
});

// Access-denied (Discord elevated) and pipe-busy both surface as EPERM-family
// failures but need opposite advice: "restart Discord un-elevated" vs "wait and
// retry". Conflating them told users to wait for something that never clears.
test('provider.login reports discord_pipe_denied distinctly (Discord elevated)', async () => {
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(os.tmpdir(), 'no-such-tokens.json'),
    connect: () => Promise.reject(new Error('discord_pipe_denied')),
  });
  assert.deepEqual(await p.login(), { ok: false, error: 'discord_pipe_denied' });
});

// An unexpected connector throw must not masquerade as a specific diagnosis.
test('provider.login falls back to discord_not_running on an unknown connect error', async () => {
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(os.tmpdir(), 'no-such-tokens.json'),
    connect: () => Promise.reject(new Error('something_else_entirely')),
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

// A bad soundboard ref (non-numeric sound id) is rejected BEFORE any socket opens.
test('provider.runAction rejects a bad soundboard ref without connecting', async () => {
  let connected = false;
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(os.tmpdir(), 'no-such-tokens.json'),
    connect: () => { connected = true; return Promise.reject(new Error('should not connect')); },
  });
  assert.deepEqual(await p.runAction({ type: 'discordSoundboard', sound: '|not-a-number' }), { ok: false, error: 'bad_sound' });
  assert.equal(connected, false);
});

test('provider.runAction plays a soundboard sound into the current channel', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000, username: 'me' } }));
  const sent = [];
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret', tokensFile,
    connect: () => Promise.resolve(fakePipe((cmd, args) => {
      sent.push([cmd, args]);
      if (cmd === 'GET_SELECTED_VOICE_CHANNEL') return { id: '111', name: 'General', type: 2 };
      return {};
    })),
  });
  // The stored ref carries the sound's origin guild; play targets the current channel.
  assert.deepEqual(await p.runAction({ type: 'discordSoundboard', sound: '199737254929760257|123' }), { ok: true });
  const play = sent.find((s) => s[0] === 'PLAY_SOUNDBOARD_SOUND');
  assert.deepEqual(play[1], { sound_id: '123', guild_id: '199737254929760257', channel_id: '111' });
  p.close();
});

test('provider.listSoundboardSounds maps sounds and labels them with guild names', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000, username: 'me' } }));
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret', tokensFile,
    connect: () => Promise.resolve(fakePipe((cmd) => {
      if (cmd === 'GET_SOUNDBOARD_SOUNDS') return { sounds: [
        { sound_id: '123', guild_id: '199737254929760257', name: 'Airhorn' },
        { id: '7', name: 'Quack' },       // built-in default (no guild)
        { name: 'broken' },               // no id → dropped
      ] };
      if (cmd === 'GET_GUILDS') return { guilds: [{ id: '199737254929760257', name: 'Server One' }] };
      return {};
    })),
  });
  const sounds = await p.listSoundboardSounds();
  assert.equal(sounds.length, 2);
  assert.deepEqual(sounds[0], { id: '123', guildId: '199737254929760257', name: 'Airhorn', guild: 'Server One' });
  assert.deepEqual(sounds[1], { id: '7', guildId: '', name: 'Quack', guild: '' });
  p.close();
});

test('provider.listSoundboardSounds degrades to [] when not connected', async () => {
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(os.tmpdir(), 'no-such-tokens.json'),
    connect: () => Promise.reject(new Error('discord_not_running')),
  });
  assert.deepEqual(await p.listSoundboardSounds(), []);
  p.close();
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

test('provider.watchVoice subscribes VOICE_STATE_* and refreshes the roster on a member join', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000, username: 'me' } }));
  // A mutable roster: a member joins between the initial snapshot and the event.
  const roster = [{ user: { id: '900', username: 'alice' }, nick: 'Alice', voice_state: {} }];
  const sock = fakePipe((cmd) => {
    if (cmd === 'GET_VOICE_SETTINGS') return { mute: false, mode: { type: 'VOICE_ACTIVITY' } };
    if (cmd === 'GET_SELECTED_VOICE_CHANNEL') return { id: '111', name: 'General', type: 2, voice_states: roster };
    return {};
  });
  // Capture every SUBSCRIBE event name + channel the provider registers.
  const subs = [];
  const origWrite = sock.write;
  sock.write = (buf) => {
    try {
      if (buf.readInt32LE(0) === 1) {
        const len = buf.readInt32LE(4);
        const msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
        if (msg.cmd === 'SUBSCRIBE') subs.push(`${msg.evt}@${msg.args && msg.args.channel_id}`);
      }
    } catch { /* not a JSON frame — ignore */ }
    return origWrite(buf);
  };
  const p = dc.createDiscordProvider({ clientId: 'id', clientSecret: 'secret', tokensFile, connect: () => Promise.resolve(sock) });
  const states = [];
  const stop = p.watchVoice((s) => states.push(s));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(states[states.length - 1].members.length, 1);
  // Membership events are subscribed per-channel alongside speaking.
  for (const evt of ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE']) {
    assert.ok(subs.includes(`${evt}@111`), `missing subscription ${evt}@111`);
  }
  // Someone joins → a VOICE_STATE_CREATE fires; the debounced recompute re-reads
  // the (now larger) roster and pushes it to the widget.
  roster.push({ user: { id: '901', username: 'bob' }, nick: 'Bob', voice_state: {} });
  sock.emit('data', dc.encodeFrame(1, { cmd: 'DISPATCH', evt: 'VOICE_STATE_CREATE', data: { channel_id: '111', user: { id: '901' } } }));
  await new Promise((r) => setTimeout(r, 360));   // > the 300ms VOICE_STATE debounce
  assert.equal(states[states.length - 1].members.length, 2);
  assert.ok(states[states.length - 1].members.some((m) => m.id === '901'));
  stop();
  p.close();
});

// ── Notification mirroring (opt-in scope + live feed) ────────────────────────

test('watchVoice subscribes NOTIFICATION_CREATE when wanted and delivers projected items', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } }));
  const sock = fakePipe((cmd) => (cmd === 'GET_VOICE_SETTINGS' ? { mute: false } : {}));
  const subs = [];
  const origWrite = sock.write;
  sock.write = (buf) => {
    try {
      if (buf.readInt32LE(0) === 1) {
        const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString('utf8'));
        if (msg.cmd === 'SUBSCRIBE') subs.push(msg.evt);
      }
    } catch { /* not a JSON frame — ignore */ }
    return origWrite(buf);
  };
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret', tokensFile,
    connect: () => Promise.resolve(sock), wantNotifications: () => true,
  });
  const got = [];
  const stop = p.watchVoice(() => {}, (n) => got.push(n));
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(subs.includes('NOTIFICATION_CREATE'));
  assert.equal(p.notifStatus(), 'ok');
  sock.emit('data', dc.encodeFrame(1, { cmd: 'DISPATCH', evt: 'NOTIFICATION_CREATE', data: {
    title: 'marci', body: 'hey', icon_url: 'https://cdn.discordapp.com/a.png', channel_id: '199737254929760257',
  } }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, [{ title: 'marci', body: 'hey', icon: 'https://cdn.discordapp.com/a.png', channelId: '199737254929760257' }]);
  stop();
  p.close();
});

test('watchVoice without the wantNotifications opt-in never subscribes NOTIFICATION_CREATE', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } }));
  const sock = fakePipe((cmd) => (cmd === 'GET_VOICE_SETTINGS' ? { mute: false } : {}));
  const subs = [];
  const origWrite = sock.write;
  sock.write = (buf) => {
    try {
      if (buf.readInt32LE(0) === 1) {
        const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString('utf8'));
        if (msg.cmd === 'SUBSCRIBE') subs.push(msg.evt);
      }
    } catch { /* ignore */ }
    return origWrite(buf);
  };
  const p = dc.createDiscordProvider({ clientId: 'id', clientSecret: 'secret', tokensFile, connect: () => Promise.resolve(sock) });
  const stop = p.watchVoice(() => {}, () => { throw new Error('must never be called'); });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(!subs.includes('NOTIFICATION_CREATE'));
  assert.equal(p.notifStatus(), 'off');
  stop();
  p.close();
});

test('a token minted without the scope reports scope_missing but keeps the voice watch alive', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } }));
  // Like fakePipe, but the NOTIFICATION_CREATE subscribe is rejected (no scope).
  const sock = new EventEmitter();
  sock.destroy = () => {};
  sock.write = (buf) => {
    const op = buf.readInt32LE(0);
    const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString('utf8'));
    queueMicrotask(() => {
      if (op === 0) { sock.emit('data', dc.encodeFrame(1, { cmd: 'DISPATCH', evt: 'READY', data: {} })); return; }
      if (msg.cmd === 'AUTHENTICATE') { sock.emit('data', dc.encodeFrame(1, { cmd: 'AUTHENTICATE', nonce: msg.nonce, data: {} })); return; }
      if (msg.cmd === 'SUBSCRIBE' && msg.evt === 'NOTIFICATION_CREATE') {
        sock.emit('data', dc.encodeFrame(1, { cmd: 'SUBSCRIBE', nonce: msg.nonce, evt: 'ERROR', data: { message: 'missing scope' } }));
        return;
      }
      const data = msg.cmd === 'GET_VOICE_SETTINGS' ? { mute: false } : {};
      sock.emit('data', dc.encodeFrame(1, { cmd: msg.cmd, nonce: msg.nonce, data }));
    });
    return true;
  };
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret', tokensFile,
    connect: () => Promise.resolve(sock), wantNotifications: () => true,
  });
  const states = [];
  const stop = p.watchVoice((s) => states.push(s), () => {});
  assert.equal(await waitFor(() => p.notifStatus() === 'scope_missing'), true);
  assert.equal(p.notifStatus(), 'scope_missing');
  // The voice watch itself still delivered a live snapshot.
  assert.equal(states[states.length - 1].ok, true);
  stop();
  p.close();
});

test('login requests the notification scope only when wanted', async () => {
  const authScopes = [];
  const mkDeps = (want) => ({
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json'),
    wantNotifications: () => want,
    connect: () => Promise.resolve(fakePipe((cmd, args) => {
      if (cmd === 'AUTHORIZE') { authScopes.push(args.scopes); return { code: 'abc' }; }
      return {};
    })),
    fetch: async (url) => ({
      ok: true,
      json: async () => (String(url).includes('/users/@me')
        ? { id: '1', username: 'me' }
        : { access_token: 't', refresh_token: 'r', expires_in: 3600 }),
    }),
  });
  assert.equal((await dc.createDiscordProvider(mkDeps(false)).login()).ok, true);
  assert.equal(authScopes[0].includes('rpc.notifications.read'), false);
  assert.equal((await dc.createDiscordProvider(mkDeps(true)).login()).ok, true);
  assert.equal(authScopes[1].includes('rpc.notifications.read'), true);
});

// ── Login error classification ───────────────────────────────────────────────

test('errDetail caps and stringifies Discord-provided text', () => {
  assert.equal(dc.errDetail('  boom  '), 'boom');
  assert.equal(dc.errDetail(null), '');
  assert.equal(dc.errDetail('x'.repeat(500)).length, 200);
});

test('loginCloseError maps "Invalid Client ID" to its own code, keeps the message', () => {
  const e = dc.loginCloseError({ code: 4000, message: 'Invalid Client ID' });
  assert.equal(e.message, 'invalid_client_id');
  assert.equal(e.detail, 'Invalid Client ID');
  const other = dc.loginCloseError({ code: 1000, message: 'connection reset' });
  assert.equal(other.message, 'discord_closed');
  assert.equal(other.detail, 'connection reset');
  assert.equal(dc.loginCloseError(null).message, 'discord_closed');
});

test('authorizeError keeps an explicit deny as authorize_denied, else authorize_failed + detail', () => {
  assert.equal(dc.authorizeError({ message: 'Authorization denied by user' }).message, 'authorize_denied');
  assert.equal(dc.authorizeError({ message: 'User cancelled the request' }).message, 'authorize_denied');
  assert.equal(dc.authorizeError(null).message, 'authorize_denied');   // no message → assume deny
  const e = dc.authorizeError({ message: 'Something else went wrong' });
  assert.equal(e.message, 'authorize_failed');
  assert.equal(e.detail, 'Something else went wrong');
});

// The exact message a real user hit (the `rpc` scope is owner/tester-only and is
// refused for an Activity app or one with no redirect registered). It must NOT
// fall into authorize_failed, whose note blames the signed-in account alone.
test('authorizeError singles out invalid_scope, keeping Discord\'s wording', () => {
  const e = dc.authorizeError({ message: 'OAuth2 Error: invalid_scope: The requested scope is invalid, unknown, or malformed.' });
  assert.equal(e.message, 'invalid_scope');
  assert.equal(e.detail, 'OAuth2 Error: invalid_scope: The requested scope is invalid, unknown, or malformed.');
});

test('login surfaces the real-world invalid_scope rejection end to end', async () => {
  const p = dc.createDiscordProvider(loginDeps((sock, msg) => {
    sock.emit('data', dc.encodeFrame(1, {
      cmd: 'AUTHORIZE', nonce: msg.nonce, evt: 'ERROR',
      data: { code: 4007, message: 'OAuth2 Error: invalid_scope: The requested scope is invalid, unknown, or malformed.' },
    }));
  }));
  assert.deepEqual(await p.login(), {
    ok: false, error: 'invalid_scope',
    detail: 'OAuth2 Error: invalid_scope: The requested scope is invalid, unknown, or malformed.',
  });
});

// A login-dance pipe: handshake → READY; AUTHORIZE answered by `onAuthorize`
// (return a frame body, or emit whatever you like on the socket yourself).
function loginPipe(onAuthorize) {
  const sock = new EventEmitter();
  sock.destroy = () => {};
  sock.write = (buf) => {
    const op = buf.readInt32LE(0);
    const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString('utf8'));
    queueMicrotask(() => {
      if (op === 0) { sock.emit('data', dc.encodeFrame(1, { cmd: 'DISPATCH', evt: 'READY', data: {} })); return; }
      if (op === 1 && msg.cmd === 'AUTHORIZE') onAuthorize(sock, msg);
    });
    return true;
  };
  return sock;
}

function loginDeps(onAuthorize, fetchImpl) {
  return {
    clientId: 'id', clientSecret: 'secret',
    tokensFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json'),
    connect: () => Promise.resolve(loginPipe(onAuthorize)),
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ access_token: 't', refresh_token: 'r', expires_in: 3600 }) })),
  };
}

test('login surfaces an AUTHORIZE rejection as authorize_failed with Discord\'s message', async () => {
  const p = dc.createDiscordProvider(loginDeps((sock, msg) => {
    sock.emit('data', dc.encodeFrame(1, { cmd: 'AUTHORIZE', nonce: msg.nonce, evt: 'ERROR', data: { message: 'Invalid scopes' } }));
  }));
  assert.deepEqual(await p.login(), { ok: false, error: 'authorize_failed', detail: 'Invalid scopes' });
});

test('login surfaces a close-with-Invalid-Client-ID as invalid_client_id', async () => {
  const p = dc.createDiscordProvider(loginDeps((sock) => {
    sock.emit('data', dc.encodeFrame(2, { code: 4000, message: 'Invalid Client ID' }));
  }));
  assert.deepEqual(await p.login(), { ok: false, error: 'invalid_client_id', detail: 'Invalid Client ID' });
});

test('login maps an invalid_client token exchange to bad_client_secret', async () => {
  const p = dc.createDiscordProvider(loginDeps(
    (sock, msg) => sock.emit('data', dc.encodeFrame(1, { cmd: 'AUTHORIZE', nonce: msg.nonce, data: { code: 'abc' } })),
    async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client', error_description: 'Invalid client credentials' }) }),
  ));
  assert.deepEqual(await p.login(), { ok: false, error: 'bad_client_secret', detail: 'Invalid client credentials' });
});

test('login maps a thrown token exchange (network) to token_network_failed', async () => {
  const p = dc.createDiscordProvider(loginDeps(
    (sock, msg) => sock.emit('data', dc.encodeFrame(1, { cmd: 'AUTHORIZE', nonce: msg.nonce, data: { code: 'abc' } })),
    async () => { throw new Error('fetch failed'); },
  ));
  assert.deepEqual(await p.login(), { ok: false, error: 'token_network_failed', detail: 'fetch failed' });
});

test('login keeps token_exchange_failed for other OAuth errors, with the description', async () => {
  const p = dc.createDiscordProvider(loginDeps(
    (sock, msg) => sock.emit('data', dc.encodeFrame(1, { cmd: 'AUTHORIZE', nonce: msg.nonce, data: { code: 'abc' } })),
    async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Invalid redirect_uri' }) }),
  ));
  assert.deepEqual(await p.login(), { ok: false, error: 'token_exchange_failed', detail: 'Invalid redirect_uri' });
});

test('a second concurrent login is refused with login_in_progress', async () => {
  let firstSock = null;
  const deps = loginDeps((sock) => { firstSock = sock; /* dialog pending — never answer */ });
  // The retry after the first login settles must not wait out the 120s authorize
  // timeout — fail its pipe connect instantly instead.
  const pipeOnce = deps.connect;
  let calls = 0;
  deps.connect = () => (++calls >= 2 ? Promise.reject(new Error('discord_not_running')) : pipeOnce());
  const p = dc.createDiscordProvider(deps);
  const first = p.login();
  await waitFor(() => !!firstSock);
  assert.deepEqual(await p.login(), { ok: false, error: 'login_in_progress' });
  firstSock.emit('close');                       // user closes Discord mid-consent
  assert.equal((await first).error, 'discord_closed');
  // The guard is released — the same provider accepts a fresh login attempt.
  assert.equal((await p.login()).error, 'discord_not_running');
});

test('a rejected AUTHENTICATE whose refresh hard-fails clears creds and reports not_connected', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xdc-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ discord: { accessToken: 'revoked', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } }));
  const sock = new EventEmitter();
  sock.destroy = () => {};
  sock.write = (buf) => {
    const op = buf.readInt32LE(0);
    const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString('utf8'));
    queueMicrotask(() => {
      if (op === 0) { sock.emit('data', dc.encodeFrame(1, { cmd: 'DISPATCH', evt: 'READY', data: {} })); return; }
      if (msg.cmd === 'AUTHENTICATE') sock.emit('data', dc.encodeFrame(1, { cmd: 'AUTHENTICATE', nonce: msg.nonce, evt: 'ERROR', data: { message: 'Invalid token' } }));
    });
    return true;
  };
  const p = dc.createDiscordProvider({
    clientId: 'id', clientSecret: 'secret', tokensFile,
    connect: () => Promise.resolve(sock),
    // The refresh attempt is refused hard (token revoked) → creds are cleared.
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }),
  });
  const r = await p.voiceState();
  assert.deepEqual(r, { ok: false, error: 'not_connected' });
  assert.equal((await p.status()).connected, false);   // creds actually cleared
  p.close();
});
