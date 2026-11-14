'use strict';
// Sends one encrypted notification to a browser's push service and says whether the
// subscription is gone.

const https = require('node:https');
const { isPublicUrl, publicLookup } = require('../net-guard.js');

const DEFAULT_TTL = 600;             // 10 minutes: a stale "timer finished" is noise
const SEND_TIMEOUT_MS = 10_000;

/**
 * POST one encrypted body to one endpoint. Split out from the store so the test
 * suite can drive it against a local server, and so the retry/expiry policy
 * lives in exactly one place above it.
 *
 * `request` is injectable for the same reason; production uses https.request.
 */
function postToService({ endpoint, body, jwt, vapidPublicKey, ttl = DEFAULT_TTL, urgency = 'normal', request = https.request, timeoutMs = SEND_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(endpoint); } catch { return resolve({ ok: false, status: 0, error: 'bad_endpoint' }); }
    if (u.protocol !== 'https:') return resolve({ ok: false, status: 0, error: 'insecure_endpoint' });
    // Checked again on every send, not only at subscribe time: a store written
    // by an older build, or edited by hand, must not get a pass.
    if (!isPublicUrl(endpoint)) return resolve({ ok: false, status: 0, error: 'blocked_endpoint' });
    let settled = false;
    let deadline = null;
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(v); } };
    const req = request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: 'POST',
      // The connect-time half of the check above: a public-looking name that
      // resolves to loopback/LAN space is refused here.
      lookup: publicLookup,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': body.length,
        TTL: String(Math.max(0, Math.min(86400, ttl | 0))),
        Urgency: urgency === 'high' ? 'high' : 'normal',
        Authorization: 'vapid t=' + jwt + ', k=' + vapidPublicKey,
      },
    }, (res) => {
      // The answer is a status code; nothing in the body is useful to us and a
      // service can return a long one, so it is drained rather than collected.
      res.resume();
      res.on('end', () => settle({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => settle({ ok: false, status: 0, error: (e && e.code) || 'network' }));
    // setTimeout above is an idle timeout; a service that trickles its reply
    // would hold the send open forever. Cap the whole exchange too.
    deadline = setTimeout(() => {
      if (typeof req.destroy === 'function') req.destroy(new Error('timeout'));
      settle({ ok: false, status: 0, error: 'timeout' });
    }, timeoutMs * 2);
    if (deadline.unref) deadline.unref();
    req.end(body);
  });
}

/** 404 and 410 are the service saying the subscription no longer exists. */
const isGone = (status) => status === 404 || status === 410;

module.exports = { DEFAULT_TTL, SEND_TIMEOUT_MS, postToService, isGone };
