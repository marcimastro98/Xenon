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
const { makeCredsNormalizer, createTokenStore, FORM } = require('./stream-common');

const {
  API, TOKEN_URL, REVOKE_URL, REDIRECT_URI, SCOPES, NOTIF_SCOPE, notifScopeState, errDetail,
  loginCloseError, authorizeError,
} = require('./discord/rpc-sign-in.js');

const {
  OP_HANDSHAKE, OP_FRAME, OP_CLOSE, OP_PING, OP_PONG, encodeFrame, createDecoder, trustedIpcSocket,
  connectPipe,
} = require('./discord/rpc-pipe.js');
const IDLE_MS = 60000;          // idle-close the authed socket after a minute
const CMD_TIMEOUT_MS = 8000;
const AUTHORIZE_TIMEOUT_MS = 120000;   // the user has to click "Authorize" in Discord
const GUILD_VOICE = 2;          // channel.type for a normal voice channel
const AUDIO_FEATURES = new Set(['noise_suppression', 'echo_cancellation', 'automatic_gain_control', 'qos']);
const {
  DEFAULT_USER_VOL, toggleValue, nextPttType, nudgedVolume, userVolumeAbs, userVolumeFor,
} = require('./discord/rpc-voice-values.js');
// How many per-user overrides we track for the socket hold below. Naturally
// bounded by a voice channel's size; capped anyway so nothing here can grow
// without limit.
const MAX_USER_OVERRIDES = 200;

// `scope` is the space-separated list Discord reported when the token was issued.
// 400 is far above the ~60 characters the five scopes take, and short enough that
// a corrupted file cannot bloat the store.
const normalizeDiscordCreds = makeCredsNormalizer({ userId: 40, username: 100, scope: 400 });

// ── Pure helpers (unit-tested; no I/O) ──────────────────────────────────────

const {
  isSnowflake, avatarUrl, channelMembers, isSoundId, parseSoundRef, normNotification, normSound,
} = require('./discord/rpc-shapes.js');

const { RPC_DEBUG, logDispatch } = require('./discord/rpc-debug.js');

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
  const tokensFile = d.tokensFile || path.join(__dirname, 'stream-tokens.json');
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

  // ── Live voice watch (event subscription; see watchVoice) ──────────────────
  // When a consumer (the dashboard widget, via the server's SSE) is watching, we
  // SUBSCRIBE to Discord's voice events and push a fresh state on each change
  // instead of being polled. While watching the socket is kept alive (idle-close
  // disabled) and re-established with backoff if Discord drops it.
  const WATCH_EVENTS = ['VOICE_SETTINGS_UPDATE', 'VOICE_CHANNEL_SELECT'];
  const RECONNECT_MAX_MS = 30000;
  let watching = false;
  let watchCb = null;          // called with a client-safe voiceState() on any change
  let notifyCb = null;         // called with a client-safe normNotification() per notification
  // 'off' (feature disabled / not watching) | 'ok' (live) | 'scope_missing' (the
  // stored token was minted without NOTIF_SCOPE → the user must re-link once).
  let notifState = 'off';
  let lastNotifSubError = '';  // de-dups the subscribe-rejection log line
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
    // The socket is gone, so Discord has already restored whatever per-user
    // settings we had applied — holding the next socket open for them would
    // guard values that no longer exist.
    userOverrides.clear();
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
    // A live watcher — or a per-user override we're holding for Discord — keeps
    // the socket up on purpose; never idle-close it.
    if (watching || userOverrides.size) { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } return; }
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
            (left) => fail(new Error(left.accessToken ? 'discord_closed' : 'not_connected')),
            () => fail(new Error('not_connected')),
          );
          return;
        }
        _connectPipe().then((s) => {
          if (settled) { try { s.destroy(); } catch { /* ignore */ } return; }
          sock = s;
          const decode = createDecoder(handleMessage);
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

  // Exchange the refresh token for a fresh access token. Only a revoked or expired
  // refresh token (invalid_grant) unlinks the account: a 5xx, a rate limit or a bad
  // client secret must keep the login, or a hiccup forces the user to link again.
  async function refresh() {
    const c = await creds();
    if (!c.refreshToken) return false;
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM, signal: AbortSignal.timeout(5000),
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: c.refreshToken }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.access_token) { await persistToken(data); return true; }
      if (data && String(data.error || '').toLowerCase() === 'invalid_grant') await clearCreds();
      return false;
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

  // A failed login, logged. Every failure path funnels through here so a user
  // report ("Could not start login") always has a matching server-side line with
  // Discord's real words — before this, login failures were completely silent.
  function loginFail(error, detail) {
    // Only reason CODES travel as `error`. An unexpected exception's message
    // (a TypeError, a disk error while saving the token) arrived here as if it
    // were one, matched nothing on the page and was shown as the bare generic
    // "Could not start login"; it now travels as the detail of `login_failed`.
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(String(error || ''))) {
      detail = detail || error;
      error = 'login_failed';
    }
    const d = errDetail(detail);
    console.error('[discord] login failed:', error + (d ? ' — ' + d : ''));
    const out = { ok: false, error };
    if (d) out.detail = d;
    return out;
  }

  // Interactive login: open a throwaway IPC socket, handshake, AUTHORIZE (Discord
  // shows the user a consent dialog), exchange the returned code for tokens, and
  // persist them. Resolves once the user approves (or times out / is denied).
  // Single-flight: a second Connect (double-tap, or a second open dashboard) while
  // one consent dialog is pending would open a second throwaway socket and a
  // second dialog — refuse it instead.
  let loginBusy = false;
  async function login() {
    if (!configured()) return { ok: false, error: 'no_client' };
    if (loginBusy) return { ok: false, error: 'login_in_progress' };
    loginBusy = true;
    try { return await doLogin(); }
    finally { loginBusy = false; }
  }

  async function doLogin() {
    // Discord may serve only ONE concurrent RPC client: release our shared
    // socket first or the throwaway login socket gets a busy pipe and the
    // user sees "Discord isn't running" while Discord is clearly up.
    close();
    let s;
    try { s = await _connectPipe(); }
    catch (e) {
      // Pass through only the reasons connectPipe() is allowed to produce, so an
      // unexpected throw still degrades to the safe "is Discord open?" answer.
      const why = (e && e.message) || '';
      return loginFail(why === 'discord_pipe_denied' || why === 'discord_pipe_busy' ? why : 'discord_not_running');
    }
    try {
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('authorize_timeout')), AUTHORIZE_TIMEOUT_MS);
        const decode = createDecoder((op, data) => {
          if (op === OP_PING) { try { s.write(encodeFrame(OP_PONG, data)); } catch { /* ignore */ } return; }
          if (op === OP_CLOSE) { clearTimeout(timer); reject(loginCloseError(data)); return; }
          if (op !== OP_FRAME || !data) return;
          if (data.cmd === 'DISPATCH' && data.evt === 'READY') {
            // NOTIF_SCOPE is requested only when notifications are enabled at link
            // time — an opted-out user never authorizes notification access.
            const scopes = wantNotifications() ? SCOPES.concat([NOTIF_SCOPE]) : SCOPES;
            try { s.write(encodeFrame(OP_FRAME, { cmd: 'AUTHORIZE', args: { client_id: clientId, scopes }, nonce: crypto.randomUUID() })); }
            catch (e) { clearTimeout(timer); reject(e); }
            return;
          }
          if (data.cmd === 'AUTHORIZE') {
            clearTimeout(timer);
            if (data.evt === 'ERROR' || !(data.data && data.data.code)) reject(authorizeError(data.data));
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
      let res;
      try {
        res = await _fetch(TOKEN_URL, {
          method: 'POST', headers: FORM, signal: AbortSignal.timeout(8000),
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
        });
      } catch (e) {
        // Discord AUTHORIZED, but this machine can't reach discord.com (VPN,
        // firewall, proxy, offline) — a distinct, fixable cause, not "try again".
        return loginFail('token_network_failed', e && e.message);
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.access_token) {
        // The OAuth error body names the exact cause: invalid_client = wrong
        // Client Secret; anything else keeps the generic exchange error but
        // carries Discord's description for the note and the log.
        const oauthErr = (data && typeof data.error === 'string') ? data.error : '';
        return loginFail(
          oauthErr === 'invalid_client' ? 'bad_client_secret' : 'token_exchange_failed',
          (data && (data.error_description || data.message)) || oauthErr || ('http_' + res.status));
      }
      await persistToken(data);
      // Fresh token → whatever the OLD token's notification state was (e.g. a
      // sticky 'scope_missing') no longer means anything. The next watch
      // (re)connect re-probes the subscription against THIS token.
      notifState = 'off';
      const me = await fetchUser(data.access_token);
      if (me) await patchCreds({ userId: me.id, username: me.username });
      return { ok: true, connected: true, username: me ? me.username : '' };
    } catch (e) {
      return loginFail((e && e.message) || 'login_failed', e && e.detail);
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
    return {
      connected: !!c.accessToken, login: c.username, configured: configured(), notif: notifState,
      // 'granted' | 'missing' | 'unknown' — read from the grant itself, so the UI
      // can say a re-link is needed the moment the switch goes on rather than
      // after a subscription has been refused. See notifScopeState.
      notifScope: notifScopeState(c.scope),
    };
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

  // Show one text channel, group DM or DM in the Discord app (SELECT_TEXT_CHANNEL,
  // under the `rpc` scope every linked account already granted). Used by the
  // widget's "Reply" on a mirrored notification: Discord has no RPC command that
  // SENDS a message, so the closest honest thing is taking the user to the chat.
  // Never throws; the error is the RPC one, which discord-launch.js reads to
  // decide whether a starting Discord is worth waiting for.
  async function openTextChannel(channelId) {
    const id = String(channelId == null ? '' : channelId).trim();
    if (!isSnowflake(id)) return { ok: false, error: 'bad_channel' };
    try {
      await command('SELECT_TEXT_CHANNEL', { channel_id: id });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'discord_failed' };
    }
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

  // Absolute volume for slider keys: `value` is a 0–100 percentage from the
  // validated action. Deliberately capped at 100 even for the output field
  // (whose native range reaches 200%) — a slider spans the normal range; the
  // boost range stays a deliberate in-app choice.
  async function setVolumeAbs(field, value) {
    // Empty/whitespace rejects loud — Number('') is 0 and would mute the user.
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return { ok: false, error: 'bad_value' };
    const pct = Number(raw.replace(',', '.'));
    if (!Number.isFinite(pct)) return { ok: false, error: 'bad_value' };
    const vol = Math.min(100, Math.max(0, Math.round(pct)));
    await command('SET_VOICE_SETTINGS', { [field]: { volume: vol } });
    return { ok: true };
  }

  // ── Per-user local playback (SET_USER_VOICE_SETTINGS) ─────────────────────
  // Turn ONE person in your voice channel up, down or off, exactly like dragging
  // their slider in Discord's own UI. This never leaves the machine: it changes
  // what this client plays, not what anyone else hears, and it is not a moderation
  // action — a member with no permissions can do it to anybody.

  // Remember (or forget) that a user is sitting on a non-default local setting.
  // Only the socket hold in bumpIdle() reads this; it is not a cache of Discord's
  // state, so a missed entry costs an earlier idle-close, never a wrong value.
  function noteOverride(id, patch) {
    const prev = userOverrides.get(id) || { volume: DEFAULT_USER_VOL, mute: false };
    const next = { volume: patch.volume != null ? patch.volume : prev.volume, mute: patch.mute != null ? patch.mute : prev.mute };
    if (next.volume === DEFAULT_USER_VOL && !next.mute) { userOverrides.delete(id); bumpIdle(); return; }
    if (!userOverrides.has(id) && userOverrides.size >= MAX_USER_OVERRIDES) return;   // apply anyway, just don't track
    userOverrides.set(id, next);
  }

  // Our own account id, for the self check below. Reads the persisted creds
  // (identify wrote it at link time); '' when unknown, which fails open — the
  // refusal is a UX nicety, not a security boundary.
  async function selfUserId() {
    try { const c = await creds(); return c && c.userId ? String(c.userId) : ''; }
    catch { return ''; }
  }

  // The member's current local settings, read live from the channel the user is
  // in. Needed for up/down and for a mute toggle, and it doubles as the "is this
  // person actually here" check — Discord silently accepts settings for a user
  // who isn't in the channel, which would look like a control that did nothing.
  async function memberVoice(userId) {
    const chId = await currentChannelId();
    if (!chId) return { ok: false, error: 'not_in_channel' };
    let ch;
    try { ch = await command('GET_CHANNEL', { channel_id: chId }); }
    catch { return { ok: false, error: 'not_in_channel' }; }
    // A generous cap for the LOOKUP (the SSE roster stays capped at 50): a
    // person past the display cap is still someone you can turn down.
    const member = channelMembers(ch, 500).find((m) => m.id === userId);
    return member ? { ok: true, member } : { ok: false, error: 'user_not_here' };
  }

  // Shared front half of both per-user actions: validate the id and refuse our
  // own account. Discord has no per-user setting for yourself — your own levels
  // are discordInputVol/discordOutputVol — so a widget that puts a slider on
  // every row gets a named error instead of a call that reports success and
  // changes nothing.
  async function userTarget(userId) {
    const id = String(userId == null ? '' : userId).trim();
    if (!isSnowflake(id)) return { ok: false, error: 'bad_user' };
    if (id === await selfUserId()) return { ok: false, error: 'self_not_supported' };
    return { ok: true, id };
  }

  // Both actions read the channel first, even when the value is known up front
  // and no read is needed to compute it. That read is the ONLY thing that tells
  // "you are not in a call" and "that person just left" apart from success:
  // Discord accepts settings for a user who isn't there and answers OK, which
  // would give the widget a control that reports success and changes nothing.
  // It costs one local IPC round trip, and widget actions are already capped at
  // one per 250ms, so even a dragged slider pays nothing that matters.
  async function setUserVolume(userId, mode, value) {
    const target = await userTarget(userId);
    if (!target.ok) return target;
    const cur = await memberVoice(target.id);
    if (!cur.ok) return cur;
    const volume = userVolumeFor(mode, cur.member.volume, value);
    if (volume == null) return { ok: false, error: 'bad_value' };
    await command('SET_USER_VOICE_SETTINGS', { user_id: target.id, volume });
    noteOverride(target.id, { volume });
    return { ok: true };
  }

  async function setUserMute(userId, mode) {
    const target = await userTarget(userId);
    if (!target.ok) return target;
    const cur = await memberVoice(target.id);
    if (!cur.ok) return cur;
    const mute = mode === 'mute' ? true : (mode === 'unmute' ? false : !cur.member.localMute);
    await command('SET_USER_VOICE_SETTINGS', { user_id: target.id, mute });
    noteOverride(target.id, { mute });
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
        case 'discordInputVol':  return a.mode === 'set' ? await setVolumeAbs('input', a.value) : await nudgeVolume('input', 100, a.mode);
        case 'discordOutputVol': return a.mode === 'set' ? await setVolumeAbs('output', a.value) : await nudgeVolume('output', 200, a.mode);
        case 'discordUserVol':  return await setUserVolume(a.user, a.mode, a.value);
        case 'discordUserMute': return await setUserMute(a.user, a.mode);
        case 'discordAudioToggle': return await toggleAudioFeature(a.feature);
        case 'discordSoundboard':  return await playSoundboard(a.sound);
        default: return { ok: false, error: 'unsupported' };
      }
    } catch (e) {
      const msg = (e && e.message) || 'discord_failed';
      return { ok: false, error: msg === 'not_connected' ? 'not_connected' : msg };
    }
  }

  // Enumerate the user's guild voice channels (id/name/guild/guildId), capped.
  // Shared by the editor picker (listVoiceChannels) and the widget roster
  // (voiceRoster). Best-effort: a guild we can't read is skipped.
  //
  // guildId rides along with the name because the widget's Channels tab remembers
  // which servers the user collapsed, and it has to remember them by something
  // that survives a rename — and that tells two servers with the same name apart.
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
          if (c.type === GUILD_VOICE && out.length < cap) {
            out.push({ id: String(c.id), name: c.name || '', guild: guild.name || '', guildId: String(guild.id || '') });
          }
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
            return { id: vc.id, name: vc.name, guild: vc.guild, guildId: vc.guildId, members: channelMembers(full) };
          } catch { return { id: vc.id, name: vc.name, guild: vc.guild, guildId: vc.guildId, members: [] }; }
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
      // Which of the people in the list is YOU. Discord has no per-user setting
      // for your own account (your levels are discordInputVol/OutputVol), so the
      // widget needs this to leave your own row alone rather than offering a
      // slider that answers `self_not_supported`. Your own id, on your own
      // dashboard, next to your own name — nothing is revealed that the list
      // does not already show.
      const selfId = await selfUserId();
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
        channel, members, selfId,
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
    if (RPC_DEBUG) logDispatch(evt, payload);
    if (!watching) return;
    if (evt === 'NOTIFICATION_CREATE') {
      // A Discord notification (DM / mention / watched channel). Project it to the
      // client-safe shape and hand it to the consumer — no voice recompute needed.
      if (!notifyCb) return;
      const n = normNotification(payload);
      if (n) { try { notifyCb(n); } catch { /* ignore consumer error */ } }
      return;
    }
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
    // Reset up front, not after connect(): a transient connect failure must not
    // leave a STALE 'scope_missing' from a previous token showing "re-link
    // Discord" while the real state is just "reconnecting".
    notifState = 'off';
    try {
      await connect();
      for (const evt of WATCH_EVENTS) await rawSend('SUBSCRIBE', {}, evt);
      // Notification feed: best-effort, on the SAME socket/subscription set. The
      // one realistic failure is a token minted before the user opted in (no
      // NOTIF_SCOPE) — record it so the widget can say "re-link Discord" instead
      // of silently showing an empty feed. Re-attempted on every (re)connect.
      // The raw rejection is logged (once per distinct message) so a failure
      // that ISN'T scope-related is diagnosable instead of invisible.
      if (notifyCb && wantNotifications()) {
        try { await rawSend('SUBSCRIBE', {}, 'NOTIFICATION_CREATE'); notifState = 'ok'; }
        catch (e) {
          notifState = 'scope_missing';
          const msg = (e && e.message) || 'unknown';
          if (msg !== lastNotifSubError) {
            lastNotifSubError = msg;
            console.error('[discord] NOTIFICATION_CREATE subscribe rejected:', msg);
          }
        }
      }
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
  // `onNotification` (optional) receives client-safe notifications while the
  // watch is live AND wantNotifications() is true at subscribe time.
  function watchVoice(cb, onNotification) {
    watchCb = cb;
    notifyCb = typeof onNotification === 'function' ? onNotification : null;
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
    notifyCb = null; notifState = 'off';
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (recomputeTimer) { clearTimeout(recomputeTimer); recomputeTimer = null; }
    watchChannelId = null; speaking.clear(); lastVoice = null; reconnectDelay = 0;
    currentVoiceChannelId = null;
    close();
  }

  // Notification-feed health for the widget: 'off' | 'ok' | 'scope_missing'.
  function notifStatus() { return notifState; }

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
