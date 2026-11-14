'use strict';
// Talks to a Philips Hue bridge: plain requests, requests over TLS checked against the bridge's
// own certificate, and the id a bridge is known by.

const https = require('node:https');
const tls = require('node:tls');

async function httpJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 1500);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(t);
  }
}

function normHost(host) {
  return String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

// ── Who is actually answering on that address ───────────────────────────────
// A Hue bridge serves a certificate signed by Philips' own private CA, so the
// public trust store cannot verify it and `rejectUnauthorized` has to stay off.
// That is a decision about the SIGNATURE, and it was being read as a decision
// about the PEER: with verification off and nothing else checked, Xenon handed
// its bridge key to whatever answered on the stored address. Not much of an
// attack — it takes something on your LAN — but the ordinary way to get there
// is a DHCP lease moving the bridge's address onto another device, and then the
// key goes to a stranger's box for no better reason than the router reshuffling.
//
// So the certificate is not trusted for being signed; it is checked for being
// the bridge's. A Hue bridge's certificate carries its BRIDGE ID as the common
// name, and the bridge id is exactly what discovery and pairing already read.
//
// `createConnection` is what makes this safe rather than decorative: the socket
// is handshaken and inspected BEFORE it is handed to the request, so a refusal
// happens with the key still in this process. Checking on `secureConnect` of an
// already-issued request would race the header flush that carries it.
function certName(cert) {
  const cn = cert && cert.subject && cert.subject.CN;
  return String(cn || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function bridgeIdKey(id) {
  return String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
// A bridge always serves CLIP v2 here. Named rather than inlined so the tests
// can run the real function against a local TLS server without asking for a
// privileged port.
const HUE_TLS_PORT = 443;
function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(host || '')) || String(host || '').includes(':');
}

// The bridge id for a host: whatever pairing stored, else asked for once and
// remembered. An install that paired before this existed has nothing stored, and
// learning the id from the bridge is still worth doing — it is the same
// unauthenticated read discovery has always used, and it turns "anything at this
// address" into "the device that was there when Xenon last looked".
const _bridgeIds = new Map();   // host → { id, at }
const BRIDGE_ID_TTL = 60 * 60 * 1000;
async function bridgeIdOf(host, known) {
  if (known) return bridgeIdKey(known);
  const hit = _bridgeIds.get(host);
  if (hit && Date.now() - hit.at < BRIDGE_ID_TTL) return hit.id;
  const res = await httpJson(`http://${host}/api/config`, { method: 'GET' }, 1500);
  const id = bridgeIdKey(res && res.body && res.body.bridgeid);
  if (id) _bridgeIds.set(host, { id, at: Date.now() });
  return id;
}

// HTTPS JSON call for CLIP v2, over a socket whose peer has been identified.
// `bridgeId` is the id pairing recorded; without one the check falls back to
// whatever the bridge says it is (see bridgeIdOf).
function httpsJson(host, path, method, token, body, timeoutMs, bridgeId) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host, path, method,
      headers: {
        ...(token ? { 'hue-application-key': token } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      rejectUnauthorized: false,
      timeout: timeoutMs || 1500,
      createConnection(opts, onSocket) {
        const socket = tls.connect({
          host, port: HUE_TLS_PORT,
          // SNI names a host, and RFC 6066 does not allow an address there —
          // Node already warns and will drop it. A bridge is normally reached by
          // IP, so it is sent only when there is a name to send.
          ...(isIpLiteral(host) ? {} : { servername: host }),
          rejectUnauthorized: false,      // Philips' own CA; the identity check below is the real gate
        });
        socket.once('secureConnect', () => {
          const want = bridgeIdKey(bridgeId);
          const got = certName(socket.getPeerCertificate());
          // No id to compare against (a bridge that answers nothing, an offline
          // first run) is not a pass: a check that waves through whatever it
          // could not identify is the behaviour being removed.
          if (!want || !got || want !== got) {
            socket.destroy();
            onSocket(new Error('hue_bridge_identity'));
            return;
          }
          onSocket(null, socket);
        });
        socket.once('error', (e) => onSocket(e));
        return undefined;               // the request waits for onSocket
      },
    }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON body */ }
        resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, status: 0, body: null }));
    if (data) req.write(data);
    req.end();
  });
}

module.exports = {
  httpJson, normHost, certName, bridgeIdKey, HUE_TLS_PORT, isIpLiteral, _bridgeIds, BRIDGE_ID_TTL,
  bridgeIdOf, httpsJson,
};
