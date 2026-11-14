'use strict';
// The addresses of a Home Assistant server, worked out from the one the user typed, and the
// bounded download of a camera picture from it.

const http = require('node:http');
const https = require('node:https');

const HA_WS_MAX_PAYLOAD = 8 * 1024 * 1024;

// Turn a user-entered base URL ("http://192.168.1.5:8123", "https://ha.me") into
// the WebSocket API endpoint, or '' if it isn't a plain http(s) URL. A non-http
// scheme (file:, javascript:, ws:) is rejected — the token must only ever be
// sent to a real HA HTTP origin the user typed.
function haWsUrl(baseUrl) {
  const v = String(baseUrl == null ? '' : baseUrl).trim();
  if (!/^https?:\/\/\S+$/i.test(v)) return '';
  let u;
  try { u = new URL(v); } catch (e) { return ''; }
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + u.host + '/api/websocket';
}

// The HTTP(S) origin ("https://ha.me[:port]") for the same base URL, or '' if it
// isn't a plain http(s) URL. Used for the REST camera-proxy snapshot fetch. TLS
// validation is left at the default — a self-signed HA the WS client already
// can't reach over wss wouldn't authenticate here either, so there's nothing to
// gain by relaxing it (and every reason not to).
function haHttpOrigin(baseUrl) {
  const v = String(baseUrl == null ? '' : baseUrl).trim();
  if (!/^https?:\/\/\S+$/i.test(v)) return '';
  let u;
  try { u = new URL(v); } catch (e) { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  return u.protocol + '//' + u.host;
}

// Authenticated GET returning the raw body Buffer (used for camera snapshots).
// Resolves the bytes on 2xx, rejects on any other status or transport failure.
// Capped: camera_proxy is expected to answer with ONE JPEG; an endpoint that
// streams instead (MJPEG, misrouted proxy) would keep resetting the inactivity
// timeout while the buffer grew without bound, so bail past a snapshot-sized cap.
const HA_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;
function haHttpGetBuffer(urlStr, token) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('ha_bad_url')); return; }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const rq = lib.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: { Authorization: 'Bearer ' + token, Accept: 'image/jpeg' },
      timeout: 8000,
    }, (rs) => {
      const status = rs.statusCode || 0;
      const chunks = [];
      let size = 0;
      rs.on('data', (d) => {
        size += d.length;
        if (size > HA_SNAPSHOT_MAX_BYTES) { rq.destroy(new Error('ha_snapshot_too_large')); return; }
        chunks.push(d);
      });
      rs.on('end', () => {
        if (status < 200 || status >= 300) { reject(new Error('ha_snapshot_' + status)); return; }
        resolve(Buffer.concat(chunks));
      });
    });
    rq.on('error', (e) => reject(e));
    rq.on('timeout', () => rq.destroy(new Error('ha_timeout')));
    rq.end();
  });
}

function isConfigured(cfg) {
  return !!(cfg && haWsUrl(cfg.baseUrl) && String(cfg.token || '').trim());
}

module.exports = {
  HA_WS_MAX_PAYLOAD, haWsUrl, haHttpOrigin, HA_SNAPSHOT_MAX_BYTES, haHttpGetBuffer, isConfigured,
};
