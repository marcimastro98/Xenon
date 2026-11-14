'use strict';
// Limits how often one address or one paired device may ask, and how many requests a dashboard
// load is allowed.

/**
 * Fixed-window counter, bounded in memory. Used for the pre-auth pairing
 * surface (per source address) and for authenticated devices (per device).
 */
function createRateLimiter({ limit, windowMs, maxKeys = 512 }) {
  const hits = new Map();
  return {
    /** @returns {boolean} true when the caller is within its budget */
    take(key, now) {
      const k = String(key || '');
      const t = Number.isFinite(now) ? now : Date.now();
      let rec = hits.get(k);
      if (!rec || t - rec.start >= windowMs) { rec = { start: t, n: 0 }; hits.set(k, rec); }
      rec.n++;
      if (hits.size > maxKeys) {
        // Drop the oldest windows rather than growing without bound. Map keeps
        // insertion order, and an evicted key just gets a fresh budget.
        for (const [ek, er] of hits) {
          if (hits.size <= maxKeys) break;
          if (er !== rec && t - er.start >= windowMs) hits.delete(ek);
        }
        if (hits.size > maxKeys) {
          for (const ek of hits.keys()) { if (ek !== k) { hits.delete(ek); break; } }
        }
      }
      return rec.n <= limit;
    },
    reset(key) { hits.delete(String(key || '')); },
    size() { return hits.size; },
  };
}

// What ONE dashboard load costs a paired device, measured on a real paired
// browser against this build: 250 requests (116 files under js/, 67 component
// stylesheets, 11 global ones, the shared core, then the API reads and the SDK
// frames). It is here as a number the budget below is derived FROM, so the two
// cannot drift apart silently — if the shell ever gets much heavier, the
// derived budget is the thing to re-check.
const DASHBOARD_LOAD_REQUESTS = 250;

// The per-device budget. This is a ceiling on a runaway client, NOT a security
// control: the security-relevant limiter is the pre-auth one (10/min, per
// source address, guarding the pairing code), and the loopback door has no
// limit at all — so a paired device is still held to something the PC itself
// is not.
//
// It was 900/min, which is 3.6 loads, and that is inside what a person does by
// hand while setting a phone up. The requests it refused were the LAST ones of
// a load — SDK widget stylesheets and scripts mount after the shell — so the
// dashboard came up looking healthy with its widgets rendered as unstyled
// markup on a white canvas. That is the exact failure the keyed asset path
// exists to prevent, reintroduced by a counter, and invisible from the phone:
// a 429 on a stylesheet looks identical to a broken widget, and the obvious
// next move (reload) spends more of the same budget and makes it worse.
// Measured rather than reasoned: request 900 answered 200, request 901
// answered 429, with everything else in the system healthy.
//
// 24 loads a minute is far past anything a person does by hand, and still caps
// a looping client at 100 requests a second.
const DEVICE_RATE_LIMIT = DASHBOARD_LOAD_REQUESTS * 24;

module.exports = { createRateLimiter, DASHBOARD_LOAD_REQUESTS, DEVICE_RATE_LIMIT };
