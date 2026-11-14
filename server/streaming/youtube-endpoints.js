'use strict';
// Where the YouTube provider talks to Google: the addresses of sign-in and of the API, the
// permission it asks for, and the rule that a link shown as it is must be https.

const SCOPE = 'https://www.googleapis.com/auth/youtube';
const DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/youtube/v3';

// A link the dashboard shows as-is must be https, never javascript: or data:.
function httpsOnly(u, fallback) {
  try { const x = new URL(String(u || '')); return x.protocol === 'https:' ? x.href : fallback; } catch { return fallback; }
}

module.exports = { SCOPE, DEVICE_URL, TOKEN_URL, REVOKE_URL, API, httpsOnly };
