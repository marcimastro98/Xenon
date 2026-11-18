'use strict';

// One batch of anonymous feature counts to the hub (usage-stats.js). HTTPS only;
// any answer other than a 2xx, a redirect included, is a failure and never followed.

const https = require('https');
const { armDeadline } = require('../http/net-guard');

const FETCH_TIMEOUT_MS = 6000;
// `timeout` is an idle timeout only; a hub that trickles bytes would hold the
// request, and the single-flight read waiting on it, open forever. This bounds
// the whole request (net-guard.armDeadline).
const FETCH_DEADLINE_MS = 15000;

/** @param {string} url @param {object} body @returns {Promise<{ok: boolean}>} */
function postBatch(url, body) {
  return new Promise((resolve) => {
    if (!/^https:\/\//i.test(url)) return resolve({ ok: false });
    const payload = JSON.stringify(body);
    let req;
    try {
      req = https.request(url, {
        method: 'POST',
        timeout: FETCH_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        res.resume();
        // 204 is the hub's "counted".
        const code = res.statusCode || 0;
        resolve({ ok: code >= 200 && code < 300 });
      });
    } catch {
      return resolve({ ok: false });
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false }));
    armDeadline(req, FETCH_DEADLINE_MS);
    req.end(payload);
  });
}

module.exports = { postBatch };
