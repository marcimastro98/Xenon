'use strict';
// The pause after Spotify answers 429: until when every call is held back, how long is left,
// and the profile read that respects it.

const { API } = require('./spotify-endpoints.js');

function makeBackoff({ _fetch }) {
  const backoff = {
    // ── 429 circuit breaker ─────────────────────────────────────────────────────
    // Spotify rate-limits over a rolling window and answers 429 with a Retry-After
    // (seconds). The dashboard polls several endpoints every few seconds, so once we
    // trip the limit, blindly retrying keeps us pinned in the penalty box forever —
    // every call (even /me) 429s and the integration looks permanently broken. When we
    // see a 429 we back off for Retry-After and short-circuit every call until then,
    // so we stop adding load and the limit clears on its own. Dev-mode apps have low
    // limits, so this matters most there.
    _rateLimitedUntil: 0,
  };
  function rateLimited() { return Date.now() < backoff._rateLimitedUntil; }
  // How long the breaker still holds. Handed to SDK widgets so a widget can
  // wait exactly that long instead of guessing — a widget guessing short is
  // what keeps the whole account pinned in the penalty box.
  function retryAfterMs() { return Math.max(0, backoff._rateLimitedUntil - Date.now()); }
  function noteRateLimit(res) {
    let secs = 5;
    try { const h = res && res.headers && res.headers.get('retry-after'); const n = h && parseInt(h, 10); if (n) secs = Math.min(3600, Math.max(1, n)); } catch { /* default */ }
    backoff._rateLimitedUntil = Date.now() + secs * 1000;
  }

  async function fetchMe(token) {
    if (rateLimited()) return null;
    try {
      const res = await _fetch(API + '/me', { headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 429) { noteRateLimit(res); return null; }
      const data = await res.json().catch(() => null);
      return (data && data.id) ? { id: data.id, name: data.display_name || data.id } : null;
    } catch { return null; }
  }

  return { rateLimited, retryAfterMs, noteRateLimit, fetchMe };
}

module.exports = { makeBackoff };
