// Asks an https address for JSON, with a limit on time and size.

const https = require('node:https');
const { FETCH_JSON_MAX_BYTES } = require('./fetch-json-limit.js');

function fetchJson(url, timeout = 2500, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'Xenon/1.0', ...(extraHeaders || {}) };
    const req = https.get(url, { timeout, headers }, res => {
      // An answer is JSON from a weather or artwork service: anything else, or
      // anything this large, is not one, and is not read into memory.
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > FETCH_JSON_MAX_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Artwork lookup timeout')); });
    req.on('error', reject);
    // `timeout` above only fires on a quiet socket; this ends a request that
    // trickles forever (net-guard.armDeadline).
    require('../net-guard.js').armDeadline(req, Math.max(timeout * 4, 10000));
  });
}

module.exports = { fetchJson };
