'use strict';

// Opt-in anonymous version ping.
//
// The project's promise is that the app ships no telemetry, and that stays
// true: this is OFF unless the user turns it on in Settings → Generale →
// Aggiornamenti (`settings-version-ping` in index.html), and it
// exists to answer one narrow question the maintainer otherwise cannot — how
// many installs are still running an old release.
//
// Four constraints keep it honest, and each is deliberate:
//
//   1. NO new network call. The ping rides the update check the app already
//      performs (server.js, /update/check), so enabling the setting never makes
//      the app contact something it was not contacting already.
//   2. NO install id. `supporter-redeem.getInstallId` exists and would be
//      trivial to attach — that is exactly why it must not be. It is reserved
//      for ratings and supporter codes; sending it here would make usage
//      correlatable with purchases. The payload is version + platform, nothing
//      else, and the hub stores only a per-(day, version, os) counter.
//   3. AT MOST once per UTC day per install, remembered in DATA_DIR. The day is
//      recorded BEFORE the request goes out, so a network failure costs one
//      attempt rather than one attempt per dashboard load.
//   4. Fire-and-forget. It never delays, fails, or alters the update check.
//
// If any of those change, docs/privacy.html must change in the same commit —
// that page describes this file's behaviour to users in plain language.

const https = require('https');
const path = require('path');
const fsp = require('fs').promises;
const { writeFileAtomic } = require('./atomic-write');
const { HUB_BASE } = require('./supporter-redeem');

const FETCH_TIMEOUT_MS = 6000;
const MAX_RESPONSE_BYTES = 4 * 1024;
const STATE_BASENAME = 'version-ping.json';
// Mirrors VERSION_RE in the hub: refuse to send anything that is not plainly a
// version string, so a malformed package.json can never fragment the counters.
const VERSION_RE = /^\d{1,3}(?:\.\d{1,4}){0,3}(?:-[0-9a-z][0-9a-z.]{0,19})?$/i;

let _transport = postJson;   // swappable for tests
let _inflight = null;        // concurrent dashboard loads collapse to one attempt

function utcDay(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

function postJson(url, body) {
  return new Promise((resolve) => {
    if (!/^https:\/\//i.test(url)) return resolve({ ok: false, error: 'network' });
    const payload = JSON.stringify(body);
    let req;
    try {
      req = https.request(url, {
        method: 'POST',
        timeout: FETCH_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, onResponse);
    } catch {
      return resolve({ ok: false, error: 'network' });
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, error: 'network' }));
    req.end(payload);

    function onResponse(res) {
      // A redirect on this POST would mean the hub URL moved under us; treat it
      // as a failure rather than re-sending the payload somewhere unverified.
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return resolve({ ok: false, error: 'network' });
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error('body too large')); return; }
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

async function readLastDay(dataDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dataDir, STATE_BASENAME), 'utf8'));
    return parsed && typeof parsed.day === 'string' ? parsed.day : '';
  } catch {
    return '';   // missing or corrupt — treat as "never sent"
  }
}

async function rememberDay(dataDir, day) {
  await writeFileAtomic(path.join(dataDir, STATE_BASENAME), JSON.stringify({ day }));
}

// Returns a small result object describing what happened. Callers ignore it in
// production; the tests read it, which is why it is not just a boolean.
async function maybePing({ dataDir, version, enabled, os = process.platform, day = utcDay() }) {
  if (enabled !== true) return { ok: false, skipped: 'disabled' };
  if (!VERSION_RE.test(String(version || ''))) return { ok: false, skipped: 'bad_version' };
  if (_inflight) return _inflight;

  _inflight = (async () => {
    if (await readLastDay(dataDir) === day) return { ok: false, skipped: 'already_sent' };
    // Recorded first on purpose — see constraint 3 in the header.
    try { await rememberDay(dataDir, day); }
    catch { return { ok: false, skipped: 'state_unwritable' }; }

    const out = await _transport(HUB_BASE + '/version/ping', { version: String(version), os: String(os) });
    return out && out.ok === true ? { ok: true } : { ok: false, error: 'network' };
  })();

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

module.exports = {
  maybePing,
  utcDay,
  _setTransport(fn) { _transport = fn || postJson; },
};
