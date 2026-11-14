'use strict';
// Signing in to YouTube from a screen with no keyboard: the code shown, the wait for the phone,
// the token renewed, the channel's name, what the dashboard is told, and signing out.

const { FORM } = require('../stream-common.js');
const {
  SCOPE, DEVICE_URL, TOKEN_URL, REVOKE_URL, API, httpsOnly,
} = require('./youtube-endpoints.js');

function makeSignIn({
  _fetch, clientId, clientSecret, creds, patchCreds, clearCreds, persistToken, dropCaches,
}) {
  function configured() { return !!clientId && !!clientSecret; }

  async function startDeviceLogin() {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    try {
      const res = await _fetch(DEVICE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ client_id: clientId, scope: SCOPE }) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.device_code) return { ok: false, error: 'device_failed' };
      return {
        ok: true,
        deviceCode: data.device_code,
        userCode: data.user_code,
        // Shown to the user as a link: https only, whatever the service answered.
        verificationUri: httpsOnly(data.verification_url || data.verification_uri, 'https://www.google.com/device'),
        interval: data.interval || 5,
        expiresIn: data.expires_in,
      };
    } catch { return { ok: false, error: 'network' }; }
  }

  async function pollDeviceToken(deviceCode) {
    if (!configured()) return { ok: false, error: 'no_client_id' };
    if (!deviceCode || typeof deviceCode !== 'string') return { ok: false, error: 'bad_request' };
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.access_token) {
        await persistToken(data);
        dropCaches();   // a different account may have signed in
        const ch = await fetchChannel(data.access_token);
        if (ch) await patchCreds({ channel: ch.title, channelId: ch.id });
        return { ok: true, connected: true, login: ch ? ch.title : '' };
      }
      const err = String((data && data.error) || '').toLowerCase();
      if (err === 'authorization_pending') return { ok: false, pending: true };
      if (err === 'slow_down') return { ok: false, pending: true, slowDown: true };
      if (err === 'expired_token') return { ok: false, error: 'expired' };
      if (err === 'access_denied') return { ok: false, error: 'denied' };
      return { ok: false, error: err || 'token_failed' };
    } catch { return { ok: false, error: 'network' }; }
  }

  // Only a revoked or expired refresh token (invalid_grant) unlinks the account: a
  // 5xx, a rate limit or a bad client must keep the login, or a hiccup forces a new link.
  async function refresh() {
    const c = await creds();
    if (!c.refreshToken) return false;
    try {
      const res = await _fetch(TOKEN_URL, {
        method: 'POST', headers: FORM,
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: c.refreshToken }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.access_token) { await persistToken(data); return true; }
      if (data && String(data.error || '').toLowerCase() === 'invalid_grant') await clearCreds();
      return false;
    } catch { return false; }
  }

  async function fetchChannel(token) {
    try {
      const res = await _fetch(API + '/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json().catch(() => null);
      const item = data && Array.isArray(data.items) && data.items[0];
      return item ? { id: item.id, title: (item.snippet && item.snippet.title) || '' } : null;
    } catch { return null; }
  }

  async function status() {
    const c = await creds();
    return { connected: !!c.accessToken, login: c.channel, configured: configured() };
  }

  async function logout() {
    const c = await creds();
    if (c.accessToken) {
      try { await _fetch(REVOKE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ token: c.accessToken }) }); }
      catch { /* best-effort */ }
    }
    await clearCreds();
    dropCaches();
    return { ok: true };
  }

  return { configured, startDeviceLogin, pollDeviceToken, refresh, status, logout };
}

module.exports = { makeSignIn };
