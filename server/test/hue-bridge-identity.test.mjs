// Xenon talks to a Hue bridge over TLS with verification off, because the
// bridge's certificate is signed by Philips' own private CA and no public trust
// store can chain it. That is a decision about the SIGNATURE. It was being read
// as a decision about the PEER: nothing else was checked, so the bridge key went
// to whatever answered the stored address.
//
// It takes something on your LAN, so it is not much of an attack — but the
// ordinary way to get there is a DHCP lease moving the bridge's address onto
// another device, and then the key goes to a stranger's box because the router
// reshuffled. A Hue bridge's certificate carries its BRIDGE ID as the common
// name, and the bridge id is what discovery and pairing already read.
//
// This test runs the real function against a real TLS server holding a real
// certificate, and asserts on what the server RECEIVED — the only question that
// matters here is whether the key left this process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lighting-providers', 'hue.js'), 'utf8');
const REAL_ID = '001788fffe1234ab';
const TOKEN = 'the-bridge-key';

// Lift the real httpsJson, with its port pointed at the test server. Everything
// else — the connect, the identity check, the refusal — is the shipped code.
function lift(port) {
  const pick = (re) => { const m = re.exec(SRC); assert.ok(m, `missing ${re}`); return m[0]; };
  // eslint-disable-next-line no-new-func
  return new Function('https', 'tls', 'HUE_TLS_PORT', `
    ${pick(/function certName\(cert\) \{[\s\S]*?\n\}/)}
    ${pick(/function bridgeIdKey\(id\) \{[\s\S]*?\n\}/)}
    ${pick(/function isIpLiteral\(host\) \{[\s\S]*?\n\}/)}
    ${pick(/function httpsJson\(host, path, method, token, body, timeoutMs, bridgeId\) \{[\s\S]*?\n\}/)}
    return httpsJson;
  `)(https, tls, port);
}

let openssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }

const dir = openssl ? mkdtempSync(join(os.tmpdir(), 'hue-cert-')) : '';
function makeCert(cn, tag) {
  const key = join(dir, tag + '-k.pem');
  const cert = join(dir, tag + '-c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
    '-days', '2', '-nodes', '-subj', `/CN=${cn}`], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// A server holding `id` as its certificate's common name. Records the key of
// every request that reaches it.
async function bridge(id, tag) {
  const { key, cert } = makeCert(id, tag);
  const got = [];
  const srv = https.createServer({ key, cert }, (req, res) => {
    got.push(req.headers['hue-application-key'] || null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { got, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

async function ask(b, bridgeId) {
  const httpsJson = lift(b.port);
  const r = await httpsJson('127.0.0.1', '/clip/v2/resource/grouped_light', 'GET', TOKEN, null, 3000, bridgeId);
  return { answered: r.ok, requests: b.got.length, keySent: b.got.includes(TOKEN) };
}

test('the paired bridge is talked to normally', { skip: !openssl && 'openssl not available' }, async () => {
  const b = await bridge(REAL_ID, 'real');
  try {
    assert.deepEqual(await ask(b, REAL_ID), { answered: true, requests: 1, keySent: true });
  } finally { await b.close(); }
});

test('another device on that address never receives the key', { skip: !openssl && 'openssl not available' }, async () => {
  const b = await bridge('deadbeefdeadbeef', 'impostor');
  try {
    const r = await ask(b, REAL_ID);
    assert.equal(r.answered, false, 'the request went through');
    assert.equal(r.requests, 0, 'a request reached the wrong device');
    assert.equal(r.keySent, false, 'THE BRIDGE KEY WAS SENT TO THE WRONG DEVICE');
  } finally { await b.close(); }
});

test('an unidentifiable peer is refused, not waved through', { skip: !openssl && 'openssl not available' }, async () => {
  // A check that passes whatever it could not identify is the behaviour being
  // removed, so "no id to compare against" has to fail closed.
  const b = await bridge(REAL_ID, 'noid');
  try {
    const r = await ask(b, '');
    assert.equal(r.keySent, false);
    assert.equal(r.requests, 0);
  } finally { await b.close(); }
});

test('a bridge id is compared by its digits, not its punctuation', { skip: !openssl && 'openssl not available' }, async () => {
  // The id is read from the bridge in one shape and printed in another; the
  // certificate carries a third. Comparing the raw strings would refuse the
  // real bridge, which is the worst way for this to fail.
  const b = await bridge(REAL_ID, 'shape');
  try {
    for (const written of ['00:17:88:FF:FE:12:34:AB', '001788FFFE1234AB', ' 001788fffe1234ab ']) {
      assert.equal((await ask(b, written)).answered, true, `refused the real bridge written as ${written}`);
    }
  } finally { await b.close(); }
});

// ── the parts that cannot be reached by a socket ────────────────────────────
test('the check happens before the request is handed a socket', () => {
  // On `secureConnect` of an already-issued request it would race the header
  // flush that carries the key. createConnection is what makes it a gate.
  const m = /function httpsJson\(host, path, method, token, body, timeoutMs, bridgeId\) \{[\s\S]*?\n\}/.exec(SRC);
  assert.ok(m, 'httpsJson is gone');
  assert.match(m[0], /createConnection\(opts, onSocket\)/);
  assert.match(m[0], /onSocket\(new Error\('hue_bridge_identity'\)\)/);
  assert.match(m[0], /socket\.destroy\(\)/);
});

test('the paired bridge id survives a settings save', () => {
  // normalizeLightingProviders rebuilds each device from a whitelist, so a new
  // field that is not listed is wiped on the next save from any surface — and
  // the check would quietly fall back to trusting whatever answers the address.
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js'), 'utf8');
  const client = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'settings.js'), 'utf8');
  for (const [side, src] of [['server', server], ['client', client]]) {
    const m = /function normalizeLightingProviders\(value\) \{[\s\S]*?\n\}/.exec(src);
    assert.ok(m, `${side}: normalizeLightingProviders is gone`);
    assert.match(m[0], /bridgeId/, `${side}: the paired bridge id is dropped on save`);
  }
});

test('pairing records the bridge id, and discovery reports it', () => {
  // Pairing is the one moment the bridge's identity is certain: the user just
  // pressed the button on it.
  assert.match(/async function pair\(host\) \{[\s\S]*?\n\}/.exec(SRC)[0], /bridgeIdOf\(h, ''\)/);
  assert.match(/async function probe\(host\) \{[\s\S]*?\n\}/.exec(SRC)[0], /bridgeId: bridgeIdKey\(res\.body\.bridgeid\)/);
});
