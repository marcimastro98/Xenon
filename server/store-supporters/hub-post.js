// One HTTPS POST of JSON to the supporter hub, with a deadline and a limit on how much of the
// answer is read.

const https = require('node:https');
const { armDeadline } = require('../net-guard.js');

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function postJson(url, body, maxBytes = MAX_RESPONSE_BYTES, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!/^https:\/\//i.test(url)) return resolve({ ok: false, error: 'network' });
    const payload = JSON.stringify(body);
    let req;
    try {
      req = https.request(url, {
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, onResponse);
    } catch {
      return resolve({ ok: false, error: 'network' });
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, error: 'network' }));
    // `timeout` is an idle timeout only; a hub that trickles bytes would hold
    // the POST open forever. Cap the whole request at twice the idle timeout
    // the caller chose (a credits turn waits minutes on the model).
    armDeadline(req, timeoutMs * 2);
    req.end(payload);

    function onResponse(res) {
      // Never follow a redirect on a POST carrying a redeemable code. Non-3xx
      // statuses (including 400/429) carry a JSON body from the hub — parse it.
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return resolve({ ok: false, error: 'network' });
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('body too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve({ ok: false, error: 'network' }); }
      });
      res.on('error', () => resolve({ ok: false, error: 'network' }));
    }
  });
}

module.exports = { FETCH_TIMEOUT_MS, MAX_RESPONSE_BYTES, postJson };
