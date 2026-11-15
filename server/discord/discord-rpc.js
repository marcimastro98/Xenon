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

const crypto = require('crypto');
const path = require('path');
const { makeCredsNormalizer, createTokenStore } = require('../streaming/stream-common');

const {
  NOTIF_SCOPE, notifScopeState, errDetail, loginCloseError, authorizeError,
} = require('./rpc-sign-in.js');

const {
  OP_HANDSHAKE, OP_FRAME, OP_CLOSE, OP_PING, OP_PONG, encodeFrame, createDecoder, trustedIpcSocket,
  connectPipe,
} = require('./rpc-pipe.js');
const { IDLE_MS, CMD_TIMEOUT_MS } = require('./rpc-limits.js');
const {
  toggleValue, nextPttType, nudgedVolume, userVolumeAbs, userVolumeFor,
} = require('./rpc-voice-values.js');

// `scope` is the space-separated list Discord reported when the token was issued.
// 400 is far above the ~60 characters the five scopes take, and short enough that
// a corrupted file cannot bloat the store.
const normalizeDiscordCreds = makeCredsNormalizer({ userId: 40, username: 100, scope: 400 });

// ── Pure helpers (unit-tested; no I/O) ──────────────────────────────────────

const {
  isSnowflake, avatarUrl, channelMembers, isSoundId, parseSoundRef, normNotification, normSound,
} = require('./rpc-shapes.js');

const { makeWatch } = require('./rpc-watch.js');

const { makeLogin } = require('./rpc-login.js');

const { makeVoiceReads } = require('./rpc-voice-reads.js');

const { makeVoiceActions } = require('./rpc-voice-actions.js');

// ── Provider ────────────────────────────────────────────────────────────────
// deps (all optional, injectable for tests):
//   clientId / clientSecret — the user's Discord app credentials
//   tokensFile              — path to the server-only token store
//   fetch                   — fetch implementation (defaults to global fetch)
//   connect                 — pipe connector (defaults to the real named-pipe one)
//   wantNotifications       — () => bool, read at authorize/subscribe time; when
//                             true, login() also requests NOTIF_SCOPE and the live
//                             watch subscribes to NOTIFICATION_CREATE
function createDiscordProvider(deps) {
  const d = deps || {};
  const _fetch = d.fetch || ((...a) => fetch(...a));
  const _connectPipe = d.connect || connectPipe;
  const wantNotifications = typeof d.wantNotifications === 'function' ? d.wantNotifications : () => false;
  const clientId = d.clientId != null ? String(d.clientId) : '';
  const clientSecret = d.clientSecret != null ? String(d.clientSecret) : '';
  const tokensFile = d.tokensFile || path.join(__dirname, '..', 'stream-tokens.json');
  const { creds, patchCreds, clearCreds, persistToken, makeGetAccessToken } =
    createTokenStore({ tokensFile, storeKey: 'discord', normalize: normalizeDiscordCreds });

  let sock = null;
  let ready = null;            // Promise<void> resolved once handshaked + authenticated
  let idleTimer = null;
  let onReady = null;          // fired once when the IPC READY dispatch arrives
  const pending = new Map();   // nonce -> { resolve, reject }
  // Per-user local voice settings this session moved off their defaults, as
  // id -> { volume, mute }. Discord documents that voice settings changed over
  // RPC are restored "to their state before any modifications" when the app that
  // changed them disconnects — so an idle-close a minute after the user turned
  // somebody down would quietly put the volume back while the widget still drew
  // the new value. While this map is non-empty the socket is held open (see
  // bumpIdle); an override returned to its default drops out of it and the idle
  // close resumes.
  const userOverrides = new Map();

  const watchState = {
    watching: false,
    // 'off' (feature disabled / not watching) | 'ok' (live) | 'scope_missing' (the
    // stored token was minted without NOTIF_SCOPE → the user must re-link once).
    notifState: 'off',
    watchChannelId: null,   // channel we've SUBSCRIBE'd SPEAKING for (or null)
    currentVoiceChannelId: null,  // learned from VOICE_CHANNEL_SELECT — covers DM/group calls
    secretRejected: false,  // Discord answered invalid_client to a token renewal
  };
  const speaking = new Set();  // user ids currently speaking in the watched channel

  const {
    selfUserId, listVoiceChannels, voiceRoster, currentChannelId, listSoundboardSounds,
    playSoundboard, voiceState,
  } = makeVoiceReads({ creds, watchState, command });

  const {
    configured, refresh, login, logout, status,
  } = makeLogin({ _fetch, _connectPipe, wantNotifications, clientId, clientSecret, creds, patchCreds, clearCreds, persistToken, watchState, close });

  const {
    emitOffline, handleDispatch, scheduleReconnect, watchVoice, notifStatus,
  } = makeWatch({ wantNotifications, watchState, speaking, close, rawSend, connect, voiceState });

  function close() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (sock) { try { sock.destroy(); } catch { /* ignore */ } sock = null; }
    // The socket is gone, so Discord has already restored whatever per-user
    // settings we had applied — holding the next socket open for them would
    // guard values that no longer exist.
    userOverrides.clear();
    ready = null; onReady = null;
    pending.forEach((p) => p.reject(new Error('discord_closed')));
    pending.clear();
    // Lost the socket while a watcher is attached (Discord closed, pipe dropped):
    // report offline once and retry with backoff until it comes back.
    if (watchState.watching) {
      watchState.watchChannelId = null; speaking.clear();
      emitOffline(true);          // socket dropped, token still held → still linked
      scheduleReconnect();
    }
  }

  function bumpIdle() {
    // A live watcher — or a per-user override we're holding for Discord — keeps
    // the socket up on purpose; never idle-close it.
    if (watchState.watching || userOverrides.size) { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } return; }
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
        if (!token) {
          // Creds still stored: the refresh only failed for now, so the watch must
          // retry. 'not_connected' would stop it with the account still linked.
          creds().then(
            (left) => fail(new Error(watchState.secretRejected ? 'bad_client_secret' : (left.accessToken ? 'discord_closed' : 'not_connected'))),
            () => fail(new Error('not_connected')),
          );
          return;
        }
        _connectPipe().then((s) => {
          if (settled) { try { s.destroy(); } catch { /* ignore */ } return; }
          sock = s;
          // A frame that cannot be one closes the pipe: 'close' below fails what is waiting.
          const decode = createDecoder(handleMessage, () => { try { s.destroy(); } catch { /* already gone */ } });
          s.on('data', decode);
          s.on('error', () => fail(new Error('discord_closed')));
          s.on('close', () => { if (!settled) fail(new Error('discord_closed')); else close(); });
          onReady = () => {
            rawSend('AUTHENTICATE', { access_token: token }).then(done, async () => {
              // A rejected AUTHENTICATE usually means the token was revoked
              // out-of-band — e.g. the user removed the app under Discord →
              // Authorized Apps (exactly what our own re-link instructions
              // suggest). Try one refresh: a hard refresh failure clears the
              // creds, so the failure surfaces as 'not_connected' (the watch
              // stops and the widget shows "connect in Settings") instead of
              // retrying a dead token forever; a successful refresh or a
              // network blip fails transient and the next attempt retries.
              try {
                await refresh();
                const left = await creds();
                fail(new Error(left.accessToken ? 'discord_closed' : 'not_connected'));
              } catch { fail(new Error('discord_closed')); }
            });
          };
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

  const getAccessToken = makeGetAccessToken(refresh);


  const {
    openTextChannel, runAction,
  } = makeVoiceActions({ userOverrides, selfUserId, currentChannelId, playSoundboard, bumpIdle, command });

  // Is the socket currently being held open for a per-user override? Diagnostic
  // only — nothing in the app branches on it, and the tests use it to pin the
  // hold/release behaviour that keeps Discord from reverting what the user set.
  function holdingUserOverrides() { return userOverrides.size > 0; }

  // NB: getAccessToken stays a private closure — never exposed on the provider, so
  // no consumer (or generic forwarding layer) can pull a live token off it.
  return { configured, status, login, logout, runAction, openTextChannel, listVoiceChannels, listSoundboardSounds, voiceRoster, voiceState, watchVoice, notifStatus, holdingUserOverrides, close };
}

module.exports = {
  createDiscordProvider,
  normalizeDiscordCreds,
  // pure helpers exported for tests
  isSnowflake,
  isSoundId,
  parseSoundRef,
  normSound,
  normNotification,
  toggleValue,
  nextPttType,
  nudgedVolume,
  userVolumeAbs,
  userVolumeFor,
  channelMembers,
  avatarUrl,
  encodeFrame,
  createDecoder,
  notifScopeState,
  NOTIF_SCOPE,
  errDetail,
  loginCloseError,
  authorizeError,
  trustedIpcSocket,
};
