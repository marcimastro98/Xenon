'use strict';
// Discord integration via the LOCAL RPC/IPC channel — the same private socket the
// official Discord Stream Deck plugin uses. There is no cloud API for voice
// control: the Discord DESKTOP client must be running; we connect to its named
// pipe, OAuth the user's OWN app (bring-your-own client_id/secret, so no Discord
// whitelisting is needed for the app OWNER's own account), then drive voice
// settings (mute/deafen/PTT/volume/audio processing) and voice-channel select.
//
// SECURITY: tokens live in the SERVER-ONLY stream-tokens.json (shared store, key
// 'discord'); the browser only ever sees { connected, username }. Never log a
// token. A voice channel id from the wire is validated as a Discord snowflake
// before it reaches SELECT_VOICE_CHANNEL.
//
// ROBUSTNESS: every public method resolves to a plain result object and never
// throws, so a closed Discord client, a missing pipe or a bad/expired token
// degrades the Deck dispatcher and the editor picker to a clean { ok:false }
// instead of crashing the request. The IPC socket is lazy and idle-closed, so an
// unconfigured or unused Discord integration keeps zero sockets open.

const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { makeCredsNormalizer, createTokenStore, FORM } = require('./stream-common');

const API = 'https://discord.com/api';
const TOKEN_URL = API + '/oauth2/token';
const REVOKE_URL = API + '/oauth2/token/revoke';
// The redirect only has to MATCH one registered on the user's Discord app — the
// RPC AUTHORIZE returns the code over IPC, there's no browser hop — so we ask the
// user to register exactly this value and reuse it for the token exchange.
const REDIRECT_URI = 'http://localhost';
// rpc.voice.read/write drive the voice settings; identify names the account for
// the status line. These are owner-usable without Discord whitelisting the app.
const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write', 'identify'];

// IPC frame opcodes (see the RPC transport docs).
const OP_HANDSHAKE = 0, OP_FRAME = 1, OP_CLOSE = 2, OP_PING = 3, OP_PONG = 4;
const PIPE_COUNT = 10;          // discord-ipc-0 .. discord-ipc-9
const IDLE_MS = 60000;          // idle-close the authed socket after a minute
const CMD_TIMEOUT_MS = 8000;
const AUTHORIZE_TIMEOUT_MS = 120000;   // the user has to click "Authorize" in Discord
const GUILD_VOICE = 2;          // channel.type for a normal voice channel
const AUDIO_FEATURES = new Set(['noise_suppression', 'echo_cancellation', 'automatic_gain_control', 'qos']);

const normalizeDiscordCreds = makeCredsNormalizer({ userId: 40, username: 100 });

// ── Pure helpers (unit-tested; no I/O) ──────────────────────────────────────

// A Discord snowflake id (channel/guild/user) is a run of digits. Validate any
// channel id from the wire before sending it to SELECT_VOICE_CHANNEL.
function isSnowflake(s) { return typeof s === 'string' && /^\d{5,25}$/.test(s.trim()); }

// The next self-mute/deaf boolean for a mode against the current state.
function toggleValue(mode, current, onWord, offWord) {
  if (mode === onWord) return true;
  if (mode === offWord) return false;
  return !current;               // 'toggle'
}

// The next voice mode type ('PUSH_TO_TALK' | 'VOICE_ACTIVITY'). 'vad' = voice
// activity detection.
function nextPttType(mode, currentType) {
  if (mode === 'ptt') return 'PUSH_TO_TALK';
  if (mode === 'vad') return 'VOICE_ACTIVITY';
  return currentType === 'PUSH_TO_TALK' ? 'VOICE_ACTIVITY' : 'PUSH_TO_TALK';   // 'toggle'
}

// Nudge a voice volume by ±10 within Discord's range (input 0-100, output 0-200).
function nudgedVolume(current, dir, max) {
  const now = Number.isFinite(current) ? current : 0;
  const next = now + (dir === 'down' ? -10 : 10);
  return Math.max(0, Math.min(max, Math.round(next)));
}

// Map a GET_SELECTED_VOICE_CHANNEL response to a client-safe member list for the
// widget: display name (server nick > global name > username), muted/deafened
// flags (server- or self-imposed), and a speaking placeholder the live watch
// fills in. No avatars/tokens/emails — text only, capped so a huge channel can't
// bloat the SSE payload.
function channelMembers(ch, cap = 50) {
  const states = ch && Array.isArray(ch.voice_states) ? ch.voice_states : [];
  const out = [];
  for (const vs of states) {
    const u = vs && vs.user;
    if (!u || !u.id) continue;
    const st = vs.voice_state || {};
    out.push({
      id: String(u.id),
      name: vs.nick || u.global_name || u.username || '',
      mute: !!(st.mute || st.self_mute),
      deaf: !!(st.deaf || st.self_deaf),
      speaking: false,
    });
    if (out.length >= cap) break;
  }
  return out;
}

// A soundboard sound id: a run of digits. Guild sounds are snowflakes; the
// built-in default sounds have small integer ids, so accept 1-25 digits (unlike
// isSnowflake, which requires ≥5 for channel/guild/user ids).
function isSoundId(s) { return typeof s === 'string' && /^\d{1,25}$/.test(s.trim()); }

// A Deck soundboard action stores its target as an opaque "<guildId>|<soundId>"
// ref (default sounds carry an empty guild). Split it back into its parts;
// tolerate a bare sound id (no separator) for forward-compat.
function parseSoundRef(ref) {
  const s = String(ref == null ? '' : ref);
  const i = s.indexOf('|');
  if (i < 0) return { guildId: '', soundId: s.trim() };
  return { guildId: s.slice(0, i).trim(), soundId: s.slice(i + 1).trim() };
}

// Normalize one raw GET_SOUNDBOARD_SOUNDS entry to a client-safe shape. These
// RPC commands are UNDOCUMENTED, so the field names aren't guaranteed — accept
// sound_id|id and guild_id|guildId, and fall back to the id/emoji for a label.
// Returns null for an entry with no usable id.
function normSound(s) {
  if (!s || typeof s !== 'object') return null;
  const id = String(s.sound_id || s.id || '').trim();
  if (!isSoundId(id)) return null;
  const guildId = String(s.guild_id || s.guildId || '').trim();
  const name = String(s.name || s.emoji_name || id);
  return { id, guildId: isSnowflake(guildId) ? guildId : '', name };
}

// Frame a payload: [op int32 LE][len int32 LE][utf8 json].
function encodeFrame(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

// A stateful frame decoder: feed it chunks, it invokes onMessage(op, data) per
// complete frame and buffers partial ones across chunk boundaries.
function createDecoder(onMessage) {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0);
      const len = buf.readInt32LE(4);
      if (buf.length < 8 + len) break;
      const body = buf.subarray(8, 8 + len);
      buf = buf.subarray(8 + len);
      let data = null;
      try { data = JSON.parse(body.toString('utf8')); } catch { data = null; }
      onMessage(op, data);
    }
  };
}

function pipePath(i) { return '\\\\?\\pipe\\discord-ipc-' + i; }

// Try discord-ipc-0..9 in turn; resolve the first that connects, else reject.
function connectPipe() {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= PIPE_COUNT) { reject(new Error('discord_not_running')); return; }
      const sock = net.connect({ path: pipePath(i) });
      i += 1;
      const onErr = () => { sock.removeAllListeners(); try { sock.destroy(); } catch { /* ignore */ } tryNext(); };
      sock.once('error', onErr);
      sock.once('connect', () => { sock.removeListener('error', onErr); resolve(sock); });
    };
    tryNext();
  });
}

// ── Provider ────────────────────────────────────────────────────────────────
// deps (all optional, injectable for tests):
//   clientId / clientSecret — the user's Discord app credentials
//   tokensFile              — path to the server-only token store
//   fetch                   — fetch implementation (defaults to global fetch)
//   connect                 — pipe connector (defaults to the real named-pipe one)
function createDiscordProvider(deps) {
  const d = deps || {};
  const _fetch = d.fetch || ((...a) => fetch(...a));
  const _connectPipe = d.connect || connectPipe;
  const clientId = d.clientId != null ? String(d.clientId) : '';
  const clientSecret = d.clientSecret != null ? String(d.clientSecret) : '';
  const tokensFile = d.tokensFile || path.join(__dirname, 'stream-tokens.json');
  const { creds, patchCreds, clearCreds, persistToken, makeGetAccessToken } =
    createTokenStore({ tokensFile, storeKey: 'discord', normalize: normalizeDiscordCreds });

  let sock = null;
  let ready = null;            // Promise<void> resolved once handshaked + authenticated
  let idleTimer = null;
  let onReady = null;          // fired once when the IPC READY dispatch arrives
  const pending = new Map();   // nonce -> { resolve, reject }

  // ── Live voice watch (event subscription; see watchVoice) ──────────────────
  // When a consumer (the dashboard widget, via the server's SSE) is watching, we
  // SUBSCRIBE to Discord's voice events and push a fresh state on each change
  // instead of being polled. While watching the socket is kept alive (idle-close
  // disabled) and re-established with backoff if Discord drops it.
  const WATCH_EVENTS = ['VOICE_SETTINGS_UPDATE', 'VOICE_CHANNEL_SELECT'];
  const RECONNECT_MAX_MS = 30000;
  let watching = false;
  let watchCb = null;          // called with a client-safe voiceState() on any change
  let watchChannelId = null;   // channel we've SUBSCRIBE'd SPEAKING for (or null)
  let lastVoice = null;        // last emitted state (for speaking merges + de-dup)
  let reconnectTimer = null;
  let recomputeTimer = null;
  let reconnectDelay = 0;
  let currentVoiceChannelId = null;  // learned from VOICE_CHANNEL_SELECT — covers DM/group calls
  const speaking = new Set();  // user ids currently speaking in the watched channel

  function configured() { return !!clientId && !!clientSecret; }

  function close() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (sock) { try { sock.destroy(); } catch { /* ignore */ } sock = null; }
    ready = null; onReady = null;
    pending.forEach((p) => p.reject(new Error('discord_closed')));
    pending.clear();
    // Lost the socket while a watcher is attached (Discord closed, pipe dropped):
    // report offline once and retry with backoff until it comes back.
    if (watching) {
      watchChannelId = null; speaking.clear();
      emitOffline(true);          // socket dropped, token still held → still linked
      scheduleReconnect();
    }
  }

  function bumpIdle() {
    // A live watcher keeps the socket up on purpose — never idle-close it.
    if (watching) { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } return; }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(close, IDLE_MS);
  }

  // Route an incoming frame: reply to pings, resolve the READY gate, and match
  // command responses back to their nonce (evt:'ERROR' → reject).
  function handleMessage(op, data) {
    if (op === OP_PING) { try { sock.write(encodeFrame(OP_PONG, data)); } catch { /* ignore */ } return; }
    if (op === OP_CLOSE) { close(); return; }
    if (op !== OP_FRAME || !data) return;
    if (data.cmd === 'DISPATCH' && data.evt === 'READY') { const cb = onReady; onReady = null; if (cb) cb(); return; }
    // Subscribed voice events arrive as nonce-less DISPATCH frames — route them to
    // the live watch instead of the nonce-matched command table below.
    if (data.cmd === 'DISPATCH') { handleDispatch(data.evt, data.data); return; }
    const nonce = data.nonce;
    if (nonce && pending.has(nonce)) {
      const p = pending.get(nonce);
      pending.delete(nonce);
      if (data.evt === 'ERROR') p.reject(new Error((data.data && data.data.message) || 'discord_rpc_error'));
      else p.resolve(data.data);
    }
  }

  // Send a command frame and await its nonce-matched response. Assumes the socket
  // is up (used during the handshake and by command() after connect()). `evt` is
  // set only for SUBSCRIBE/UNSUBSCRIBE frames, which name the event they target.
  function rawSend(cmd, args, evt) {
    const nonce = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (pending.delete(nonce)) reject(new Error('discord_request_timeout')); }, CMD_TIMEOUT_MS);
      const wrap = (fn) => (v) => { clearTimeout(timer); fn(v); };
      pending.set(nonce, { resolve: wrap(resolve), reject: wrap(reject) });
      const frame = { cmd, args, nonce };
      if (evt) frame.evt = evt;
      try { sock.write(encodeFrame(OP_FRAME, frame)); }
      catch (e) { pending.delete(nonce); clearTimeout(timer); reject(e); }
    });
  }

  // Open + authenticate the shared IPC socket (single-flight, idle-closed). Reads
  // a fresh access token each time so a refreshed token is picked up.
  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
      const fail = (e) => { if (settled) return; settled = true; clear(); reject(e); close(); };
      const done = () => { if (settled) return; settled = true; clear(); bumpIdle(); resolve(); };
      // One guard covers the WHOLE handshake — token refresh (a network call),
      // pipe connect, handshake and authenticate — so a stalled token endpoint or
      // an unresponsive pipe can never leave a command awaiting connect() forever.
      timer = setTimeout(() => fail(new Error('discord_timeout')), CMD_TIMEOUT_MS);
      Promise.resolve().then(getAccessToken).then((token) => {
        if (settled) return;
        if (!token) { fail(new Error('not_connected')); return; }
        _connectPipe().then((s) => {
          if (settled) { try { s.destroy(); } catch { /* ignore */ } return; }
          sock = s;
          const decode = createDecoder(handleMessage);
          s.on('data', decode);
          s.on('error', () => fail(new Error('discord_closed')));
          s.on('close', () => { if (!settled) fail(new Error('discord_closed')); else close(); });
          onReady = () => { rawSend('AUTHENTICATE', { access_token: token }).then(done).catch(fail); };
          try { s.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: clientId })); }
          catch (e) { fail(e); }
        }, (e) => fail(e));
      }, (e) => fail(e instanceof Error ? e : new Error('discord_config_failed')));
    });
    ready.catch(() => {});      // prevent unhandled rejection if nothing awaits yet
    return ready;
  }

  async function command(cmd, args) {
    await connect();
    bumpIdle();
    return rawSend(cmd, args || {});
  }

  // Exchange the refresh token for a fresh access token; clear creds on hard fail.
  async function refresh() {
    const c = await creds();
    if (!c.refreshToken) return false;
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM, signal: AbortSignal.timeout(5000),
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: c.refreshToken }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.access_token) { await clearCreds(); return false; }
      await persistToken(data);
      return true;
    } catch { return false; }   // network blip: keep creds, fail this attempt
  }
  const getAccessToken = makeGetAccessToken(refresh);

  async function fetchUser(token) {
    try {
      const res = await _fetch(API + '/users/@me', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
      const u = await res.json().catch(() => null);
      return (u && u.id) ? { id: String(u.id), username: u.global_name || u.username || '' } : null;
    } catch { return null; }
  }

  // Interactive login: open a throwaway IPC socket, handshake, AUTHORIZE (Discord
  // shows the user a consent dialog), exchange the returned code for tokens, and
  // persist them. Resolves once the user approves (or times out / is denied).
  async function login() {
    if (!configured()) return { ok: false, error: 'no_client' };
    let s;
    try { s = await _connectPipe(); } catch { return { ok: false, error: 'discord_not_running' }; }
    try {
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('authorize_timeout')), AUTHORIZE_TIMEOUT_MS);
        const decode = createDecoder((op, data) => {
          if (op === OP_PING) { try { s.write(encodeFrame(OP_PONG, data)); } catch { /* ignore */ } return; }
          if (op === OP_CLOSE) { clearTimeout(timer); reject(new Error('discord_closed')); return; }
          if (op !== OP_FRAME || !data) return;
          if (data.cmd === 'DISPATCH' && data.evt === 'READY') {
            try { s.write(encodeFrame(OP_FRAME, { cmd: 'AUTHORIZE', args: { client_id: clientId, scopes: SCOPES }, nonce: crypto.randomUUID() })); }
            catch (e) { clearTimeout(timer); reject(e); }
            return;
          }
          if (data.cmd === 'AUTHORIZE') {
            clearTimeout(timer);
            if (data.evt === 'ERROR' || !(data.data && data.data.code)) reject(new Error((data.data && data.data.message) || 'authorize_denied'));
            else resolve(data.data.code);
          }
        });
        s.on('data', decode);
        s.on('error', () => { clearTimeout(timer); reject(new Error('discord_closed')); });
        // A graceful pipe close before the AUTHORIZE reply (e.g. a bad client_id)
        // must reject now, not hang until the 120s authorize timeout.
        s.on('close', () => { clearTimeout(timer); reject(new Error('discord_closed')); });
        try { s.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: clientId })); }
        catch (e) { clearTimeout(timer); reject(e); }
      });
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM, signal: AbortSignal.timeout(8000),
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.access_token) return { ok: false, error: 'token_exchange_failed' };
      await persistToken(data);
      const me = await fetchUser(data.access_token);
      if (me) await patchCreds({ userId: me.id, username: me.username });
      return { ok: true, connected: true, username: me ? me.username : '' };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'login_failed' };
    } finally {
      try { s.destroy(); } catch { /* ignore */ }
    }
  }

  async function logout() {
    try {
      const c = await creds();
      if (c.accessToken && configured()) {
        try {
          await _fetch(REVOKE_URL, {
            method: 'POST', headers: FORM, signal: AbortSignal.timeout(5000),
            body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token: c.accessToken }),
          });
        } catch { /* best-effort revoke */ }
      }
      await clearCreds();   // temp+rename write — re-throws on disk failure
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'logout_failed' };
    } finally {
      close();
    }
    return { ok: true };
  }

  // Client-safe state — NEVER includes tokens.
  async function status() {
    const c = await creds();
    return { connected: !!c.accessToken, login: c.username, configured: configured() };
  }

  // ── Voice actions (each resolves to { ok } and never throws) ──────────────
  async function setSelf(field, mode, onWord, offWord) {
    let value;
    if (mode === onWord) value = true;
    else if (mode === offWord) value = false;
    else { const cur = await command('GET_VOICE_SETTINGS'); value = toggleValue(mode, !!(cur && cur[field]), onWord, offWord); }
    await command('SET_VOICE_SETTINGS', { [field]: value });
    return { ok: true };
  }

  async function setPtt(mode) {
    let type;
    if (mode === 'ptt' || mode === 'vad') type = nextPttType(mode);
    else { const cur = await command('GET_VOICE_SETTINGS'); type = nextPttType('toggle', cur && cur.mode && cur.mode.type); }
    await command('SET_VOICE_SETTINGS', { mode: { type } });
    return { ok: true };
  }

  async function selectVoice(channelId) {
    const id = String(channelId == null ? '' : channelId).trim();
    if (!isSnowflake(id)) return { ok: false, error: 'bad_channel' };
    await command('SELECT_VOICE_CHANNEL', { channel_id: id, force: true });
    return { ok: true };
  }

  async function leaveVoice() {
    await command('SELECT_VOICE_CHANNEL', { channel_id: null });
    return { ok: true };
  }

  async function nudgeVolume(field, max, dir) {
    const cur = await command('GET_VOICE_SETTINGS');
    const now = cur && cur[field] && Number.isFinite(cur[field].volume) ? cur[field].volume : 0;
    await command('SET_VOICE_SETTINGS', { [field]: { volume: nudgedVolume(now, dir, max) } });
    return { ok: true };
  }

  async function toggleAudioFeature(feature) {
    if (!AUDIO_FEATURES.has(feature)) return { ok: false, error: 'bad_feature' };
    const cur = await command('GET_VOICE_SETTINGS');
    await command('SET_VOICE_SETTINGS', { [feature]: !(cur && cur[feature]) });
    return { ok: true };
  }

  // The single entry point the Deck registry dispatches to. `action` is already
  // validated by the shared catalog (mode/feature coerced to allowed options).
  async function runAction(action) {
    const a = action || {};
    try {
      switch (a.type) {
        case 'discordMute':   return await setSelf('mute', a.mode, 'mute', 'unmute');
        case 'discordDeafen': return await setSelf('deaf', a.mode, 'deafen', 'undeafen');
        case 'discordPtt':    return await setPtt(a.mode);
        case 'discordJoin':   return await selectVoice(a.channel);
        case 'discordLeave':  return await leaveVoice();
        case 'discordInputVol':  return await nudgeVolume('input', 100, a.mode);
        case 'discordOutputVol': return await nudgeVolume('output', 200, a.mode);
        case 'discordAudioToggle': return await toggleAudioFeature(a.feature);
        case 'discordSoundboard':  return await playSoundboard(a.sound);
        default: return { ok: false, error: 'unsupported' };
      }
    } catch (e) {
      const msg = (e && e.message) || 'discord_failed';
      return { ok: false, error: msg === 'not_connected' ? 'not_connected' : msg };
    }
  }

  // Enumerate the user's guild voice channels (id/name/guild), capped. Shared by
  // the editor picker (listVoiceChannels) and the widget roster (voiceRoster).
  // Best-effort: a guild we can't read is skipped.
  async function enumVoiceChannels(cap) {
    const g = await command('GET_GUILDS');
    const guilds = (g && Array.isArray(g.guilds)) ? g.guilds.slice(0, 30) : [];
    const out = [];
    for (const guild of guilds) {
      if (out.length >= cap) break;
      try {
        const ch = await command('GET_CHANNELS', { guild_id: guild.id });
        const chans = (ch && Array.isArray(ch.channels)) ? ch.channels : [];
        for (const c of chans) {
          if (c.type === GUILD_VOICE && out.length < cap) out.push({ id: String(c.id), name: c.name || '', guild: guild.name || '' });
        }
      } catch { /* skip unreadable guild */ }
    }
    return out;
  }

  // Voice channels across the user's guilds, for the editor picker. Degrades to []
  // so an offline Discord falls back to a typed channel-id field.
  async function listVoiceChannels() {
    try { return await enumVoiceChannels(300); } catch { return []; }
  }

  // Live roster for the widget's Channels tab: who is currently connected in each
  // voice channel. GET_CHANNELS only lists the channels, so we GET_CHANNEL each one
  // to read its voice_states. Capped (a user with many channels can't fan out into
  // hundreds of calls) and read in bounded-parallel batches to stay responsive
  // without flooding the pipe. Client-safe (display name + mute/deaf only, via
  // channelMembers — no tokens/avatars). Degrades to { ok:false } like voiceState().
  async function voiceRoster(cap = 40) {
    try {
      const chans = await enumVoiceChannels(cap);
      const channels = [];
      const BATCH = 6;
      for (let i = 0; i < chans.length; i += BATCH) {
        const filled = await Promise.all(chans.slice(i, i + BATCH).map(async (vc) => {
          try {
            const full = await command('GET_CHANNEL', { channel_id: vc.id });
            return { id: vc.id, name: vc.name, guild: vc.guild, members: channelMembers(full) };
          } catch { return { id: vc.id, name: vc.name, guild: vc.guild, members: [] }; }
        }));
        for (const r of filled) channels.push(r);
      }
      return { ok: true, channels };
    } catch (e) {
      const msg = (e && e.message) || 'discord_failed';
      return { ok: false, error: msg === 'not_connected' ? 'not_connected' : msg };
    }
  }

  // ── Soundboard (UNDOCUMENTED RPC: GET_SOUNDBOARD_SOUNDS / PLAY_SOUNDBOARD_SOUND) ─
  // The Discord desktop client drives its soundboard over these two RPC commands,
  // but Discord does not document them — so they're best-effort: a client update
  // could change or drop them, and both degrade to []/{ok:false} like the rest of
  // the provider. Playing a sound targets the voice channel the user is CURRENTLY
  // in (the same effect as clicking the sound in Discord's own soundboard panel);
  // it needs no extra scope beyond the voice ones already granted.

  // The channel the user is currently connected to (guild voice channel), read on
  // demand so a soundboard play lands in the right place. Uses the watch's learned
  // id when live (covers DM/group calls), else asks Discord directly. null = none.
  async function currentChannelId() {
    if (currentVoiceChannelId) return currentVoiceChannelId;
    try { const ch = await command('GET_SELECTED_VOICE_CHANNEL'); return (ch && ch.id) ? String(ch.id) : null; }
    catch { return null; }
  }

  // The user's usable soundboard sounds (guild + built-in), for the editor picker.
  // Client-safe: id + origin-guild id + name + a "Server" label only (no tokens,
  // no audio). Degrades to [] so an offline Discord leaves the picker empty rather
  // than erroring. Capped so a user in many servers can't bloat the response.
  async function listSoundboardSounds(cap = 500) {
    try {
      const data = await command('GET_SOUNDBOARD_SOUNDS');
      const raw = Array.isArray(data) ? data : (data && Array.isArray(data.sounds) ? data.sounds : []);
      const sounds = [];
      for (const s of raw) { const n = normSound(s); if (n) sounds.push(n); if (sounds.length >= cap) break; }
      // Best-effort guild names so the picker can label "Server › Sound".
      const names = {};
      try {
        const g = await command('GET_GUILDS');
        const guilds = (g && Array.isArray(g.guilds)) ? g.guilds : [];
        for (const gu of guilds) if (gu && gu.id) names[String(gu.id)] = gu.name || '';
      } catch { /* labels are optional */ }
      return sounds.map((s) => ({ id: s.id, guildId: s.guildId, name: s.name, guild: names[s.guildId] || '' }));
    } catch { return []; }
  }

  // Play a soundboard sound into the user's current voice channel. sound_id is
  // required; guild_id (the sound's origin server) is sent when known so Discord
  // can locate a guild sound; channel_id pins the target channel (mirrors what the
  // desktop client sends, and sidesteps an "Invalid Sound" when both are set).
  async function playSoundboard(ref) {
    const { soundId, guildId } = parseSoundRef(ref);
    if (!isSoundId(soundId)) return { ok: false, error: 'bad_sound' };
    const payload = { sound_id: soundId };
    if (isSnowflake(guildId)) payload.guild_id = guildId;
    const chId = await currentChannelId();
    if (chId) payload.channel_id = chId;
    await command('PLAY_SOUNDBOARD_SOUND', payload);
    return { ok: true };
  }

  // Current voice state for the dashboard widget: self mute/deaf, voice mode,
  // input/output volumes, the audio-processing toggles, and the voice channel the
  // user is in (or null). Client-safe (no tokens/devices). Best-effort — a closed
  // Discord or a missing token degrades to { ok:false } so the widget shows the
  // "not linked" / offline state instead of erroring.
  async function voiceState() {
    try {
      const vs = await command('GET_VOICE_SETTINGS');
      let channel = null;
      let members = [];
      try {
        let ch = await command('GET_SELECTED_VOICE_CHANNEL');
        // GET_SELECTED_VOICE_CHANNEL only reports GUILD voice channels — it returns
        // null for DM/group CALLS. When a VOICE_CHANNEL_SELECT event told us the
        // current channel (e.g. a DM call joined while watching), read it directly.
        if ((!ch || !ch.id) && currentVoiceChannelId) {
          try { ch = await command('GET_CHANNEL', { channel_id: currentVoiceChannelId }); }
          catch { /* channel not readable — leave as not-in-a-channel */ }
        }
        if (ch && ch.id) {
          channel = { id: String(ch.id), name: ch.name || '' };
          members = channelMembers(ch);
        }
      } catch (e) {
        // A genuine RPC error (not just "not in a channel") — surface it so a scope/
        // permission problem is diagnosable instead of silently looking idle.
        console.warn('[discord] voice-channel read failed:', (e && e.message) || e);
      }
      const vol = (side) => (vs && vs[side] && Number.isFinite(vs[side].volume) ? Math.round(vs[side].volume) : null);
      return {
        ok: true, connected: true,
        mute: !!(vs && vs.mute), deaf: !!(vs && vs.deaf),
        mode: (vs && vs.mode && vs.mode.type) || '',
        inputVolume: vol('input'), outputVolume: vol('output'),
        features: {
          noise_suppression: !!(vs && vs.noise_suppression),
          echo_cancellation: !!(vs && vs.echo_cancellation),
          automatic_gain_control: !!(vs && vs.automatic_gain_control),
          qos: !!(vs && vs.qos),
        },
        channel, members,
      };
    } catch (e) {
      const msg = (e && e.message) || 'discord_failed';
      return { ok: false, error: msg === 'not_connected' ? 'not_connected' : msg };
    }
  }

  // ── Live voice watch ──────────────────────────────────────────────────────
  // Subscribe to Discord's voice events and push a fresh state to `watchCb` on
  // each change, so the dashboard widget updates in real time (via SSE) instead
  // of polling. Speaking is tracked in-memory and merged onto the last snapshot
  // without an RPC round-trip (SPEAKING events fire rapidly). Settings/channel
  // changes trigger a debounced full recompute.

  // Push an "offline" state (de-duplicated) when the socket is lost. `linked` tells
  // the widget whether the ACCOUNT is still linked: a dropped pipe (Discord app
  // closed) keeps the token → linked:true (show the account, just offline); a token
  // that failed to refresh → linked:false (show the "connect in Settings" notice).
  function emitOffline(linked) {
    const next = { ok: false, connected: !!linked };
    if (lastVoice && lastVoice.ok === false && lastVoice.connected === next.connected) return;  // same offline state
    lastVoice = next;
    if (watchCb) { try { watchCb(lastVoice); } catch { /* ignore consumer error */ } }
  }

  // Emit the last snapshot with current speaking flags applied to its members.
  function emitVoice() {
    if (!watchCb || !lastVoice) return;
    if (lastVoice.ok && Array.isArray(lastVoice.members)) {
      for (const m of lastVoice.members) m.speaking = speaking.has(m.id);
    }
    try { watchCb(lastVoice); } catch { /* ignore consumer error */ }
  }

  function handleDispatch(evt, payload) {
    if (!watching) return;
    if (evt === 'SPEAKING_START' || evt === 'SPEAKING_STOP') {
      const uid = payload && payload.user_id ? String(payload.user_id) : '';
      if (!uid) return;
      if (evt === 'SPEAKING_START') speaking.add(uid); else speaking.delete(uid);
      emitVoice();                       // cheap: re-flag members, no RPC
      return;
    }
    if (evt === 'VOICE_STATE_CREATE' || evt === 'VOICE_STATE_UPDATE' || evt === 'VOICE_STATE_DELETE') {
      // Someone joined/left/(un)muted the current channel — refresh the member list.
      // Debounced a touch wider than a settings/channel change: membership latency is
      // forgiving, and VOICE_STATE_UPDATE can burst (per-member flag toggles), so the
      // wider window collapses the flurry into a single read. Speaking is handled
      // instantly above, so this never delays the "talking" indicator.
      scheduleRecompute(300);
      return;
    }
    if (evt === 'VOICE_CHANNEL_SELECT') {
      // Authoritative "current channel" signal — and the ONLY one that covers DM/
      // group calls, which GET_SELECTED_VOICE_CHANNEL does not report. null = left.
      currentVoiceChannelId = (payload && payload.channel_id) ? String(payload.channel_id) : null;
    }
    scheduleRecompute();                 // VOICE_SETTINGS_UPDATE / VOICE_CHANNEL_SELECT
  }

  function scheduleRecompute(delay = 150) {
    if (recomputeTimer) return;          // collapse a burst of events into one read
    recomputeTimer = setTimeout(() => { recomputeTimer = null; recompute().catch(() => {}); }, delay);
  }

  // Re-read the full voice state, re-point the SPEAKING subscription if the
  // channel changed, prune stale speakers, then emit.
  async function recompute() {
    if (!watching) return;
    const st = await voiceState();
    lastVoice = st;
    const chId = (st.ok && st.channel) ? st.channel.id : null;
    if (chId !== watchChannelId) await resubscribeSpeaking(chId);
    if (st.ok && Array.isArray(st.members)) {
      const present = new Set(st.members.map((m) => m.id));
      for (const id of Array.from(speaking)) if (!present.has(id)) speaking.delete(id);
    } else speaking.clear();
    emitVoice();
  }

  // SPEAKING_START/STOP and VOICE_STATE_* are per-channel subscriptions — swap them
  // when the user moves channels so the widget reflects who's talking AND who's in
  // the channel live (a member joining/leaving fires VOICE_STATE_*, not SPEAKING).
  // Best-effort: a failed (un)subscribe just loses live updates for that channel.
  const CHANNEL_EVENTS = ['SPEAKING_START', 'SPEAKING_STOP', 'VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE'];
  async function resubscribeSpeaking(newId) {
    const old = watchChannelId;
    watchChannelId = newId;
    speaking.clear();
    try {
      if (old) {
        for (const evt of CHANNEL_EVENTS) await rawSend('UNSUBSCRIBE', { channel_id: old }, evt).catch(() => {});
      }
      if (newId) {
        for (const evt of CHANNEL_EVENTS) await rawSend('SUBSCRIBE', { channel_id: newId }, evt);
      }
    } catch { /* live speaking / presence indicators are best-effort */ }
  }

  function scheduleReconnect() {
    if (!watching || reconnectTimer) return;
    reconnectDelay = Math.min(reconnectDelay ? reconnectDelay * 2 : 2000, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; startWatch(); }, reconnectDelay);
  }

  // Establish the socket, subscribe to the global voice events, and take an
  // initial snapshot. Retries with backoff on a transient failure; stops quietly
  // if there's no token (nothing to watch until the user links Discord again).
  async function startWatch() {
    if (!watching) return;
    try {
      await connect();
      for (const evt of WATCH_EVENTS) await rawSend('SUBSCRIBE', {}, evt);
      watchChannelId = null; speaking.clear();
      reconnectDelay = 0;
      await recompute();
    } catch (e) {
      const msg = (e && e.message) || '';
      if (msg === 'not_connected') {     // no/expired token — surface "not linked", don't spin
        emitOffline(false);
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        return;
      }
      emitOffline(true);                 // Discord unreachable but still linked → retry
      scheduleReconnect();               // close() may have scheduled already; idempotent
    }
  }

  // Attach a live watcher. Returns a stop() function. Only one watcher at a time
  // (the server registers a single one, fanned out to all SSE clients).
  function watchVoice(cb) {
    watchCb = cb;
    watching = true;
    reconnectDelay = 0;
    lastVoice = null;
    currentVoiceChannelId = null;   // reset only on a fresh watch, not per reconnect
    startWatch();
    return stopWatch;
  }

  function stopWatch() {
    watching = false;                    // close() below won't reconnect
    watchCb = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (recomputeTimer) { clearTimeout(recomputeTimer); recomputeTimer = null; }
    watchChannelId = null; speaking.clear(); lastVoice = null; reconnectDelay = 0;
    currentVoiceChannelId = null;
    close();
  }

  // NB: getAccessToken stays a private closure — never exposed on the provider, so
  // no consumer (or generic forwarding layer) can pull a live token off it.
  return { configured, status, login, logout, runAction, listVoiceChannels, listSoundboardSounds, voiceRoster, voiceState, watchVoice, close };
}

module.exports = {
  createDiscordProvider,
  normalizeDiscordCreds,
  // pure helpers exported for tests
  isSnowflake,
  isSoundId,
  parseSoundRef,
  normSound,
  toggleValue,
  nextPttType,
  nudgedVolume,
  channelMembers,
  encodeFrame,
  createDecoder,
};
