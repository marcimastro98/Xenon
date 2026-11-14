'use strict';
// Signing in to the Discord desktop app over its local pipe: the Authorize click, the code
// exchanged for tokens, the token renewed, who is signed in, what the dashboard is told, and
// signing out.

const crypto = require('node:crypto');
const { FORM } = require('../stream-common.js');
const {
  API, TOKEN_URL, REVOKE_URL, REDIRECT_URI, SCOPES, NOTIF_SCOPE, notifScopeState, errDetail,
  loginCloseError, authorizeError,
} = require('./rpc-sign-in.js');
const {
  OP_HANDSHAKE, OP_FRAME, OP_CLOSE, OP_PING, OP_PONG, encodeFrame, createDecoder,
} = require('./rpc-pipe.js');
const { AUTHORIZE_TIMEOUT_MS } = require('./rpc-limits.js');

function makeLogin({
  _fetch, _connectPipe, wantNotifications, clientId, clientSecret, creds, patchCreds, clearCreds,
  persistToken, watchState, close,
}) {
  function configured() { return !!clientId && !!clientSecret; }

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
        }, () => { try { s.destroy(); } catch { /* already gone */ } });
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
      watchState.notifState = 'off';
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
      connected: !!c.accessToken, login: c.username, configured: configured(), notif: watchState.notifState,
      // 'granted' | 'missing' | 'unknown' — read from the grant itself, so the UI
      // can say a re-link is needed the moment the switch goes on rather than
      // after a subscription has been refused. See notifScopeState.
      notifScope: notifScopeState(c.scope),
    };
  }

  return { configured, refresh, login, logout, status };
}

module.exports = { makeLogin };
