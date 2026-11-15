'use strict';
// Signing in to Twitch with a device code: the code shown to the user, the wait for the user to
// enter it, the token renewed, who is signed in, what the dashboard is told, and signing out.

const { FORM } = require('./stream-common.js');
const {
  SCOPES, DEVICE_URL, TOKEN_URL, REVOKE_URL, HELIX, httpsOnly,
} = require('./twitch-endpoints.js');

function makeSignIn({ _fetch, clientId, creds, patchCreds, clearCreds, persistToken, dropCaches }) {
  function configured() { return !!clientId; }

  // Step 1 of the device flow: ask Twitch for a device + user code to show.
  async function startDeviceLogin() {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    try {
      // NB: Twitch's device endpoint expects `scopes` (not the RFC-8628 `scope`).
      const res = await _fetch(DEVICE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ client_id: clientId, scopes: SCOPES }) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.device_code) return { ok: false, error: 'device_failed' };
      return {
        ok: true,
        deviceCode: data.device_code,
        userCode: data.user_code,
        // Shown to the user as a link: https only, whatever the service answered.
        verificationUri: httpsOnly(data.verification_url || data.verification_uri, 'https://www.twitch.tv/activate'),
        interval: data.interval || 5,
        expiresIn: data.expires_in,
      };
    } catch { return { ok: false, error: 'network' }; }
  }

  // Step 2: the dashboard polls this until the user authorises (or it expires).
  // Returns { ok:false, pending:true } while waiting — not an error.
  async function pollDeviceToken(deviceCode) {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    if (!deviceCode || typeof deviceCode !== 'string') return { ok: false, error: 'bad_request' };
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({ client_id: clientId, scopes: SCOPES, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.access_token) {
        await persistToken(data);
        dropCaches();   // a different account may have signed in
        const me = await fetchUser(data.access_token);
        if (me) await patchCreds({ login: me.login, userId: me.id });
        return { ok: true, connected: true, login: me ? me.login : '' };
      }
      const msg = String((data && (data.message || data.error)) || '').toLowerCase();
      if (msg.includes('authorization_pending') || msg.includes('pending')) return { ok: false, pending: true };
      if (msg.includes('slow_down')) return { ok: false, pending: true, slowDown: true };
      if (msg.includes('expired')) return { ok: false, error: 'expired' };
      return { ok: false, error: 'denied' };
    } catch { return { ok: false, error: 'network' }; }
  }

  // Exchange the refresh token for a fresh access token. Only a refresh token Twitch
  // refuses unlinks the account: 401, or 400 "Invalid refresh token". A 5xx, a rate
  // limit or a bad client id must keep the login, or a hiccup forces a new link.
  async function refresh() {
    const c = await creds();
    if (!c.refreshToken) return false;
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: c.refreshToken }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.access_token) { await persistToken(data); return true; }
      const badToken = res.status === 400 && data && /invalid refresh token/i.test(String(data.message || ''));
      if (res.status === 401 || badToken) await clearCreds();
      return false;
    } catch { return false; }   // network blip: keep creds, just fail this attempt
  }

  async function fetchUser(token) {
    try {
      const res = await _fetch(HELIX + '/users', { headers: { 'Client-Id': clientId, Authorization: 'Bearer ' + token } });
      const data = await res.json().catch(() => null);
      const u = data && Array.isArray(data.data) && data.data[0];
      return u ? { id: u.id, login: u.login } : null;
    } catch { return null; }
  }

  // Client-safe state — NEVER includes tokens.
  async function status() {
    const c = await creds();
    return { connected: !!c.accessToken, login: c.login, configured: configured() };
  }

  async function logout() {
    const c = await creds();
    if (c.accessToken) {
      try { await _fetch(REVOKE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ client_id: clientId, token: c.accessToken }) }); }
      catch { /* best-effort revoke */ }
    }
    await clearCreds();
    dropCaches();
    return { ok: true };
  }

  return { configured, startDeviceLogin, pollDeviceToken, refresh, status, logout };
}

module.exports = { makeSignIn };
