// Every server module that talks HTTPS to the internet bounds the WHOLE request
// with net-guard.armDeadline, not only the socket's idle timeout.
//
// The `timeout` option of http(s).get/request fires only after the socket goes
// quiet, so a server that trickles a byte every few seconds holds the request,
// and any single-flight promise waiting on it, open forever (net-guard.js). These
// clients are copies of one another and the deadline reached some copies and not
// others; this file is what stops the next copy from drifting.
//
// Part 1 is a static scan: in every server file that loads `https`, each direct
// `https.get(` / `https.request(` call needs an `armDeadline(` call in the same
// file, unless the file is listed in EXEMPT with the number of calls it may leave
// without one and the reason.
// Part 2 runs the real clients against a server that trickles its headers
// forever, with the deadline shortened, and checks each call ends and frees its
// single-flight slot.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Part 1: static scan ─────────────────────────────────────────────────────

// Files that load `https` and leave `undeadlined` direct calls without
// armDeadline (0 when they reach https only through a variable the scan cannot
// see). The count must match exactly, so the list shrinks as gaps close.
const EXEMPT = {
  // The seven Gemini calls that were all in server.js: two are still there, five moved
  // with their functions or routes into server/ai/ (tools/restructure). The total stays seven.
  'server.js': {
    undeadlined: 2,
    reason: 'the Gemini calls still here (the chat and one speech request) go to the fixed Google API host with an idle timeout each; a total deadline for them is still to do. The artwork lookup in the same file uses armDeadline.',
  },
  'ai/routes-voice.js': {
    undeadlined: 1,
    reason: 'the Gemini speech request of /api/tts, moved out of server.js unchanged with its route: fixed Google API host, idle timeout, total deadline still to do.',
  },
  'ai/gemini-one-shot.js': {
    undeadlined: 1,
    reason: 'the one-question Gemini call, moved out of server.js unchanged: fixed Google API host, idle timeout, total deadline still to do.',
  },
  'ai/gemini-search-json.js': {
    undeadlined: 2,
    reason: 'the Gemini web search and JSON calls, moved out of server.js unchanged: fixed Google API host, idle timeout each, total deadline still to do.',
  },
  'ai/gemini-transcribe.js': {
    undeadlined: 1,
    reason: 'the Gemini speech-to-text call, moved out of server.js unchanged: fixed Google API host, idle timeout, total deadline still to do.',
  },
  'ai/local-whisper-install.js': {
    undeadlined: 1,
    reason: 'the Whisper download, moved out of ai-local.js unchanged: it fetches models of several hundred MB with progress shown to the user; a fixed total cap would cut slow but healthy downloads. The web search (ai/local-search-page.js) uses armDeadline.',
  },
  'sdk-proxy.js': {
    undeadlined: 0,
    reason: 'calls through mod.request (http or https, hosts the user granted) and caps the whole exchange with its own PROXY_DEADLINE_MS timer.',
  },
  'paired/push-send.js': {
    undeadlined: 0,
    reason: 'the push sender, moved out of web-push.js unchanged: the request function is injected (https.request in production) and the whole send is capped by its own timer at twice SEND_TIMEOUT_MS.',
  },
  'ai-local-server.js': {
    undeadlined: 0,
    reason: "the user's own OpenAI-compatible server (loopback or LAN), reached through http or https per URL, with its own whole-request timer.",
  },
  'actions/home-assistant.js': {
    undeadlined: 0,
    reason: "the user's own Home Assistant, on the LAN or at a remote URL they chose, reached through lib.request (http or https per URL) so this scan cannot count it; it has only an idle timeout today, a total cap is a follow-up.",
  },
  'actions/unifi.js': {
    undeadlined: 0,
    reason: 'a UniFi console on the user LAN (self-signed TLS), reached through lib.request; not an internet service.',
  },
  'lighting-providers/hue.js': {
    undeadlined: 1,
    reason: 'a Hue bridge on the user LAN (self-signed TLS); not an internet service.',
  },
  'remote-control/sunshine.js': {
    undeadlined: 1,
    reason: 'Sunshine on 127.0.0.1 only (isLocalhost guard), loopback with a self-signed certificate.',
  },
  'remote-https.js': {
    undeadlined: 0,
    reason: 'an HTTPS server (createServer) for paired devices; it makes no outbound call.',
  },
};

// Browser code, tests, user data and the packages/core junction never load https.
const SKIP_TOP = new Set(['js', 'public', 'test', 'data', 'shared', 'vendor']);

function serverFiles(dir = SERVER, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    if (!rel && SKIP_TOP.has(ent.name)) continue;
    const childRel = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...serverFiles(path.join(dir, ent.name), childRel));
    else if (ent.isFile() && /\.c?js$/.test(ent.name)) out.push(childRel);
  }
  return out;
}

// Comment lines and trailing comments out, so prose that names a call is not one.
function codeOnly(src) {
  return src.split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .map((line) => line.replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}

const LOADS_HTTPS = /require\(\s*['"](?:node:)?https['"]\s*\)/;
const count = (re, s) => (s.match(re) || []).length;

function scan() {
  const rows = [];
  for (const rel of serverFiles()) {
    const src = codeOnly(fs.readFileSync(path.join(SERVER, rel), 'utf8'));
    if (!LOADS_HTTPS.test(src)) continue;
    const calls = count(/\bhttps\.(?:get|request)\s*\(/g, src);
    const deadlines = count(/\barmDeadline\s*\(\s*[A-Za-z_$]/g, src);
    rows.push({ rel, calls, deadlines, missing: Math.max(0, calls - deadlines) });
  }
  return rows;
}

test('every module that calls https bounds each call with armDeadline, or says why not', () => {
  const rows = scan();
  const names = rows.map((r) => r.rel);
  // The scan must actually see the clients, or every check below passes vacuously.
  for (const known of ['community-catalog.js', 'community-limited.js', 'news.js', 'server.js']) {
    assert.ok(names.includes(known), 'scan missed ' + known);
  }
  const problems = [];
  for (const r of rows) {
    const ex = EXEMPT[r.rel];
    if (ex) {
      if (r.missing !== ex.undeadlined) {
        problems.push(`${r.rel}: ${r.missing} https call(s) without armDeadline, EXEMPT allows ${ex.undeadlined}`);
      }
      continue;
    }
    if (r.calls === 0) {
      problems.push(`${r.rel}: loads https but makes no direct https.get/https.request call the scan can see; bound it with armDeadline or list it in EXEMPT with the reason`);
    } else if (r.missing) {
      problems.push(`${r.rel}: ${r.calls} https call(s), only ${r.deadlines} armDeadline; a trickling server holds the request open forever (net-guard.js)`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every EXEMPT entry still loads https and gives a reason', () => {
  const names = new Set(scan().map((r) => r.rel));
  for (const [rel, ex] of Object.entries(EXEMPT)) {
    assert.ok(names.has(rel), `${rel} no longer loads https: drop it from EXEMPT`);
    assert.ok(typeof ex.reason === 'string' && ex.reason.length > 30, rel + ' needs a reason');
  }
});

// ── Part 2: the real clients against a trickling server ─────────────────────

const SHORT_DEADLINE_MS = 150;
const STUCK_AFTER_MS = 3000;

// Shorten the deadline BEFORE the modules load: they destructure armDeadline at
// require time. The asked-for value is recorded to check it is a sane one.
const guard = require('../net-guard.js');
const realArmDeadline = guard.armDeadline;
const asked = [];
guard.armDeadline = (req, ms) => { asked.push(ms); return realArmDeadline(req, SHORT_DEADLINE_MS); };

// Sends a status line, then one header byte every 50 ms: the idle timeout never
// fires and the response never starts.
const sockets = new Set();
let connections = 0;
const trickle = net.createServer((socket) => {
  connections++;
  sockets.add(socket);
  socket.on('error', () => {});
  socket.write('HTTP/1.1 200 OK\r\nX-Slow: ');
  const t = setInterval(() => socket.write('a'), 50);
  socket.on('close', () => { clearInterval(t); sockets.delete(socket); });
});
await new Promise((resolve) => trickle.listen(0, '127.0.0.1', resolve));
const target = `http://127.0.0.1:${trickle.address().port}/`;

// Every outbound https call lands on the trickling server instead of the internet.
const https = require('node:https');
const http = require('node:http');
https.get = (_url, opts, cb) => http.get(target, opts, cb);
https.request = (_url, opts, cb) => http.request(target, opts, cb);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-deadline-'));
after(() => {
  usage._reset();
  for (const s of sockets) s.destroy();
  trickle.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const messages = require('../community-messages.js');
const limited = require('../community-limited.js');
const ratings = require('../community-ratings.js');
const installs = require('../community-installs.js');
const redeem = require('../supporter-redeem.js');
const versionPing = require('../version-ping.js');
const usage = require('../usage-stats.js');
const aiModels = require('../ai-models.js');
const aiLocal = require('../ai-local.js');
const adblock = require('../embedded-browser-adblock.js');

async function settles(promise) {
  let timer;
  const stuck = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${STUCK_AFTER_MS} ms: no total deadline`)), STUCK_AFTER_MS);
  });
  try { return await Promise.race([promise, stuck]); }
  finally { clearTimeout(timer); for (const s of sockets) s.destroy(); }
}

// `again`: a second call must reach the network too, which it only does when
// the first call's single-flight slot was released on the deadline path.
const CASES = [
  { name: 'community-messages', again: true, run: () => messages.fetchMessages(false) },
  { name: 'community-limited', again: true, run: () => limited.fetchStatus('signal') },
  { name: 'community-ratings', again: true, run: () => ratings.fetchRatings({ ids: 'signal' }) },
  { name: 'community-installs', again: true, run: () => installs.fetchInstallCounts({ ids: 'signal' }) },
  { name: 'supporter-redeem', again: false, run: () => redeem.hubPost('/deadline-probe', { probe: true }) },
  {
    name: 'version-ping', again: false,
    run: () => versionPing.maybePing({ dataDir: tmp, version: '5.0.0', enabled: true, fresh: true }),
  },
  {
    name: 'usage-stats', again: false,
    run: () => {
      usage.configure({ dataDir: tmp, enabled: () => true });
      usage.record('cap.deadlineProbe');
      return usage.maybeSend({ enabled: true, supporter: false });
    },
  },
  { name: 'ai-models', again: true, run: () => aiModels.refreshOllamaCatalog({ force: true }) },
  { name: 'ai-local web search', again: false, run: () => aiLocal.localWebSearch('xenon', 8000) },
  {
    name: 'embedded-browser-adblock', again: true,
    run: () => adblock.install(path.join(tmp, 'adblock')).catch((e) => ({ error: e.message })),
  },
];

for (const c of CASES) {
  test(`${c.name}: a trickling server cannot hold the request open`, async () => {
    const before = connections;
    const askedBefore = asked.length;
    await settles(c.run());
    assert.ok(connections > before, 'the call never reached the network');
    const mine = asked.slice(askedBefore);
    assert.ok(mine.length > 0, 'no armDeadline on the request');
    for (const ms of mine) assert.ok(ms >= 10000 && ms <= 15 * 60 * 1000, `deadline ${ms} ms is not a sane total`);
    if (!c.again) return;
    const between = connections;
    await settles(c.run());
    assert.ok(connections > between, 'the second call reused the stuck single-flight promise');
  });
}
