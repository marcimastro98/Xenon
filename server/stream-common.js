'use strict';
// Shared plumbing for the streaming providers (stream-twitch.js,
// stream-youtube.js): credential normalization, the server-only token store
// with its in-memory cache, token persistence, and expiry-aware access-token
// retrieval. The OAuth flows themselves (device login, polling, refresh
// request bodies, API helpers) stay in each provider — they genuinely differ
// between Twitch and Google, and keeping them apart avoids a leaky abstraction.

const fs = require('fs');

const EXPIRY_SKEW_MS = 60_000;   // refresh a minute before the token actually expires
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

// Build a provider's credential normalizer: the base OAuth fields plus the
// provider's extra string fields ({ name: maxLen }). Coerces any stored blob
// into a clean, fully-populated shape so callers can destructure
// unconditionally. Unknown keys are dropped.
function makeCredsNormalizer(extraFields) {
  return function normalize(input) {
    const src = (input && typeof input === 'object') ? input : {};
    const out = {
      accessToken: typeof src.accessToken === 'string' ? src.accessToken : '',
      refreshToken: typeof src.refreshToken === 'string' ? src.refreshToken : '',
      expiresAt: Number.isFinite(src.expiresAt) ? src.expiresAt : 0,
    };
    for (const key of Object.keys(extraFields)) {
      out[key] = typeof src[key] === 'string' ? src[key].slice(0, extraFields[key]) : '';
    }
    return out;
  };
}

// The server-only token store shared by the providers: one JSON file
// (stream-tokens.json), one key per provider. Tokens never leave the server.
function createTokenStore({ tokensFile, storeKey, normalize }) {
  let _cache = null;   // in-memory mirror of this provider's persisted creds

  async function readStore() {
    try { return JSON.parse(await fs.promises.readFile(tokensFile, 'utf8')) || {}; }
    catch { return {}; }
  }
  async function creds() {
    if (_cache) return _cache;
    _cache = normalize((await readStore())[storeKey]);
    return _cache;
  }
  async function patchCreds(patch) {
    const all = await readStore();
    const next = Object.assign(normalize(all[storeKey]), patch);
    all[storeKey] = next;
    await fs.promises.writeFile(tokensFile, JSON.stringify(all, null, 2), 'utf8');
    _cache = next;
    return next;
  }
  function clearCreds() {
    return patchCreds(normalize({}));   // every field back to its empty default
  }
  async function persistToken(data) {
    const expiresAt = Date.now() + (Number(data.expires_in) || 0) * 1000;
    const current = await creds();
    await patchCreds({
      accessToken: data.access_token,
      // Providers may omit refresh_token on refresh (Google does) — keep the stored one.
      refreshToken: data.refresh_token || current.refreshToken,
      expiresAt,
    });
  }
  // A valid access token, refreshing via the injected provider-specific
  // `refresh` when inside the skew window, or '' when not connected / failed.
  function makeGetAccessToken(refresh) {
    return async function getAccessToken() {
      const c = await creds();
      if (!c.accessToken) return '';
      if (c.expiresAt && Date.now() > c.expiresAt - EXPIRY_SKEW_MS) {
        if (!(await refresh())) return '';
        return (await creds()).accessToken;
      }
      return c.accessToken;
    };
  }

  return { readStore, creds, patchCreds, clearCreds, persistToken, makeGetAccessToken };
}

module.exports = { makeCredsNormalizer, createTokenStore, FORM, EXPIRY_SKEW_MS };
