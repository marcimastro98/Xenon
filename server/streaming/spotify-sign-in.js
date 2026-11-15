'use strict';
// Signing in to Spotify with PKCE: the address of the consent page and the state that guards
// the way back, the code exchanged for tokens, and the token renewed.

const crypto = require('node:crypto');
const { FORM } = require('./stream-common.js');
const { AUTH_URL, TOKEN_URL, SCOPES, PENDING_TTL_MS, b64url } = require('./spotify-endpoints.js');

function makeSignIn({
  _fetch, clientId, creds, patchCreds, clearCreds, persistToken, rateLimited, noteRateLimit,
  fetchMe,
}) {
  // Short-lived PKCE state between /login (authorize) and /callback (token
  // exchange), keyed by the opaque `state`: { verifier, redirectUri, at }. In
  // memory only — an unfinished login simply expires; nothing sensitive persists.
  const pending = new Map();
  function sweepPending() {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > PENDING_TTL_MS) pending.delete(k);
  }

  function configured() { return !!clientId; }

  // Build the Spotify authorize URL. `redirectUri` must EXACTLY match one
  // registered in the user's Spotify app and is reused verbatim at token exchange.
  // Returns { ok, authUrl } and stashes the PKCE verifier under the state nonce.
  function buildAuthUrl(redirectUri) {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    if (!redirectUri) return { ok: false, error: 'no_redirect' };
    sweepPending();
    const verifier = b64url(crypto.randomBytes(48));               // 64-char verifier
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    pending.set(state, { verifier, redirectUri, at: Date.now() });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      redirect_uri: redirectUri,
      state,
      // Force the consent screen so a RECONNECT actually re-grants scopes. Without
      // it Spotify silently reuses an existing authorization — an old token that
      // predates a scope we added (e.g. user-library-read for Liked Songs) would
      // never pick up the new permission.
      show_dialog: 'true',
    });
    return { ok: true, authUrl: AUTH_URL + '?' + params.toString(), state };
  }

  // Exchange the authorization code for tokens, validating state → verifier. The
  // redirect_uri sent here must equal the one used at authorize time (Spotify
  // checks it), so we reuse the value stashed with the pending state.
  async function exchangeCode(code, state) {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    const p = state && pending.get(state);
    if (!p) return { ok: false, error: 'bad_state' };       // unknown/expired/forged → reject
    pending.delete(state);
    if (!code) return { ok: false, error: 'no_code' };
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: p.redirectUri,
          client_id: clientId, code_verifier: p.verifier,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.access_token) return { ok: false, error: 'token_failed' };
      await persistToken(data);
      const me = await fetchMe(data.access_token);
      if (me) await patchCreds({ login: me.name, userId: me.id });
      return { ok: true, connected: true, login: me ? me.name : '' };
    } catch { return { ok: false, error: 'network' }; }
  }

  async function refresh() {
    const c = await creds();
    if (!c.refreshToken) return false;
    if (rateLimited()) return false;   // honour the 429 breaker — the token endpoint is rate-limited too
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: clientId }),
      });
      if (res.status === 429) { noteRateLimit(res); return false; }   // rate-limited: KEEP creds, retry after cooldown
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.access_token) { await persistToken(data); return true; }
      // Only a DEFINITIVE auth rejection should disconnect the account. Spotify
      // returns HTTP 400 invalid_grant when the refresh token is truly revoked or
      // expired; a 5xx or any transient failure must NOT wipe the login — doing so
      // logged users out on a mere hiccup or rate-limit and forced a full re-auth
      // (the "Spotify player disappeared" bug under heavy request load).
      const invalidGrant = res.status >= 400 && res.status < 500 &&
        data && String(data.error || '').toLowerCase() === 'invalid_grant';
      if (invalidGrant) await clearCreds();
      return false;
    } catch { return false; }   // network error: keep creds, retry later
  }

  return { configured, buildAuthUrl, exchangeCode, refresh };
}

module.exports = { makeSignIn };
