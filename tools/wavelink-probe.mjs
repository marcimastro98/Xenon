// Wave Link connection diagnostic — READ-ONLY, no settings, no writes.
//
// Why this exists: Settings → "Test connection" can only say "could not reach
// Wave Link", which is true for four very different reasons (nothing listening,
// a listener that is not Wave Link, a handshake the app refuses, a Wave Link
// that answers under a name we do not recognise). This script says WHICH, so a
// user report becomes a measurement instead of a guess.
//
// Run it with Wave Link OPEN, from the Xenon install folder:
//   node tools/wavelink-probe.mjs
//
// It only opens local sockets, asks Wave Link who it is, and prints what came
// back. It never changes a mixer, a volume or a setting.

import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// Deliberately wider than the app's own sweep: the point is to find Wave Link
// even where the app would not, and then say so.
const HOSTS = ['127.0.0.1', '::1'];
const PORT_FROM = 1824;
const PORT_TO = 1839;

const TCP_TIMEOUT_MS = 500;
const WS_TIMEOUT_MS = 4000;
const RPC_TIMEOUT_MS = 4000;

// Prefer the `ws` module when the install has it (Xenon does): its handshake
// errors name the HTTP status a refusing server returned, which the built-in
// WebSocket hides. Fall back to Node's global WebSocket (Node 22+).
const WS_IMPL = (() => {
  try { return { name: 'ws (npm)', impl: require('ws') }; } catch { /* not installed */ }
  if (typeof globalThis.WebSocket === 'function') return { name: 'node global WebSocket', impl: globalThis.WebSocket };
  return { name: 'none', impl: null };
})();

const wsUrl = (host, port) => 'ws://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port;

function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (state, detail) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ state, detail });
    };
    sock.setTimeout(TCP_TIMEOUT_MS, () => finish('timeout', 'no answer in ' + TCP_TIMEOUT_MS + 'ms'));
    sock.once('connect', () => finish('open', ''));
    sock.once('error', (e) => finish('closed', (e && e.code) || String(e)));
  });
}

// Open a websocket and run one JSON-RPC call. Returns every distinguishable
// outcome as data, so the caller can print a reason rather than a boolean.
function rpcProbe(host, port, method, params) {
  return new Promise((resolve) => {
    const Impl = WS_IMPL.impl;
    let sock;
    try { sock = new Impl(wsUrl(host, port)); } catch (e) {
      resolve({ stage: 'construct', error: String((e && e.message) || e) });
      return;
    }
    let settled = false;
    let opened = false;
    const unsolicited = [];
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      clearTimeout(rpcTimer);
      try { sock.close(); } catch { /* ignore */ }
      resolve(Object.assign({ unsolicited }, out));
    };
    const openTimer = setTimeout(() => finish({ stage: 'handshake', error: 'timeout after ' + WS_TIMEOUT_MS + 'ms' }), WS_TIMEOUT_MS);
    let rpcTimer = null;

    // `ws` emits this when the server answered the upgrade with plain HTTP —
    // the one case where a status code explains the refusal.
    if (typeof sock.on === 'function') {
      sock.on('unexpected-response', (_req, res) => {
        finish({ stage: 'handshake', error: 'HTTP ' + res.statusCode + ' ' + (res.statusMessage || '') });
      });
    }
    sock.addEventListener('error', (ev) => {
      const msg = (ev && (ev.message || (ev.error && ev.error.message))) || 'connection failed';
      finish({ stage: opened ? 'rpc' : 'handshake', error: String(msg) });
    });
    sock.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      let msg;
      try { msg = JSON.parse(raw); } catch { unsolicited.push('non-JSON frame: ' + raw.slice(0, 120)); return; }
      if (msg && msg.id === 1) {
        if (msg.error) finish({ stage: 'rpc', error: JSON.stringify(msg.error) });
        else finish({ stage: 'ok', result: msg.result });
        return;
      }
      if (msg && msg.method) unsolicited.push(String(msg.method));
    });
    sock.addEventListener('open', () => {
      opened = true;
      clearTimeout(openTimer);
      const frame = { jsonrpc: '2.0', id: 1, method };
      if (params !== undefined) frame.params = params;
      try { sock.send(JSON.stringify(frame)); } catch (e) {
        finish({ stage: 'send', error: String((e && e.message) || e) });
        return;
      }
      rpcTimer = setTimeout(() => finish({ stage: 'rpc', error: 'no answer in ' + RPC_TIMEOUT_MS + 'ms' }), RPC_TIMEOUT_MS);
    });
  });
}

function line(s) { process.stdout.write(s + '\n'); }

// ---- "it answered the door and then said nothing" ---------------------------
//
// Wave Link 3 keeps a WebSocket on 1844 (in ElgatoAudioControlServer.exe, not in
// the mixer app) that completes the upgrade and then ignores a JSON-RPC 2.0
// frame entirely: no result, no error, no close, and none of the unsolicited
// pushes Wave Link 2 sent the moment a socket opened. "Open but silent" is a
// different thing from "no API", and the difference decides whether this is a
// small fix or a new integration — so before guessing, ask the socket.
//
// Everything here is read-only: it opens local connections, says hello in a few
// documented ways, and prints what came back.

const QUIET_MS = 2500;      // how long to wait for a server that speaks first
const HTTP_TIMEOUT_MS = 3000;

// Paths worth trying. A WebSocket server routes on the request path, and every
// client we have modelled connects to the root, so a moved endpoint looks
// exactly like a dead one.
const WS_PATHS = ['', '/api', '/ws', '/websocket', '/rpc', '/v1', '/wavelink'];

// A plain GET is the cheapest identification there is: a server that is not
// serving WebSockets on that path usually says what it is in the status line,
// the headers or a one-line error body.
function httpProbe(host, port, reqPath) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: reqPath || '/', method: 'GET', timeout: HTTP_TIMEOUT_MS,
      headers: { 'User-Agent': 'xenon-wavelink-probe' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { if (size < 2048) { chunks.push(c); size += c.length; } });
      res.on('end', () => resolve({
        status: res.statusCode,
        message: res.statusMessage || '',
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8').slice(0, 300).replace(/\s+/g, ' ').trim(),
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: (e && e.code) || String(e) }));
    req.end();
  });
}

// Open a socket, listen FIRST (a server that greets its clients tells us the
// protocol without being asked), then send one JSON-RPC call and wait.
export function inspectWs(host, port, reqPath, opts) {
  return new Promise((resolve) => {
    const Impl = WS_IMPL.impl;
    const url = wsUrl(host, port) + (reqPath || '');
    // Injectable so the tests can exercise the real waits in milliseconds
    // instead of the seconds a human needs to read the output.
    const quietMs = (opts && opts.quietMs) || QUIET_MS;
    const rpcMs = (opts && opts.rpcMs) || RPC_TIMEOUT_MS;
    const openMs = (opts && opts.openMs) || WS_TIMEOUT_MS;
    let sock;
    try {
      sock = (opts && opts.protocol)
        ? new Impl(url, opts.protocol, opts.wsOpts)
        : new Impl(url, opts && opts.wsOpts);
    } catch (e) { resolve({ stage: 'construct', error: String((e && e.message) || e) }); return; }

    const frames = [];
    let settled = false;
    let opened = false;
    const timers = [];
    const finish = (out) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      try { sock.close(); } catch { /* ignore */ }
      resolve(Object.assign({ frames, opened }, out));
    };
    // The handshake deadline covers the UPGRADE only, and must be cancelled the
    // moment the socket opens: the listen-then-ask phases below deliberately
    // outlast it, so leaving it armed reports every live socket as a dead one.
    // That is not theoretical — it shipped in the first draft and turned the
    // whole interrogation into "no websocket here" against a server that was
    // accepting every connection.
    const openTimer = setTimeout(() => finish({ stage: 'handshake', error: 'timeout' }), openMs);
    timers.push(openTimer);

    if (typeof sock.on === 'function') {
      sock.on('unexpected-response', (_req, res) => finish({
        stage: 'refused', status: res.statusCode, message: res.statusMessage || '',
        server: res.headers && res.headers.server,
      }));
    }
    sock.addEventListener('error', (ev) => finish({
      stage: opened ? 'open-then-error' : 'handshake',
      error: String((ev && (ev.message || (ev.error && ev.error.message))) || 'failed'),
    }));
    sock.addEventListener('close', (ev) => {
      if (opened) finish({ stage: 'closed-by-server', code: ev && ev.code, reason: String((ev && ev.reason) || '') });
    });
    sock.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      frames.push(raw.slice(0, 200));
    });
    sock.addEventListener('open', () => {
      opened = true;
      clearTimeout(openTimer);
      // Phase 1: say nothing and see whether the server does.
      timers.push(setTimeout(() => {
        if (settled) return;
        try { sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getApplicationInfo' })); }
        catch (e) { finish({ stage: 'send', error: String((e && e.message) || e) }); return; }
        // Phase 2: having asked, wait for an answer.
        timers.push(setTimeout(() => finish({ stage: frames.length ? 'spoke' : 'silent' }), rpcMs));
      }, quietMs));
    });
  });
}

export function describeWs(r) {
  if (r.stage === 'refused') return 'upgrade refused: HTTP ' + r.status + ' ' + (r.message || '') + (r.server ? ' [' + r.server + ']' : '');
  if (r.stage === 'handshake') return 'no websocket here (' + (r.error || 'failed') + ')';
  if (r.stage === 'closed-by-server') return 'connected, then the server closed it (code ' + r.code + (r.reason ? ', "' + r.reason + '"' : '') + ')';
  if (r.stage === 'open-then-error') return 'connected, then errored (' + r.error + ')';
  if (r.stage === 'silent') return 'connected, said nothing, ignored getApplicationInfo';
  if (r.stage === 'spoke') return 'connected and SENT ' + r.frames.length + ' frame(s)';
  return r.stage + (r.error ? ': ' + r.error : '');
}

// Everything we can learn about a port that opens but will not talk to us.
export async function deepProbe(host, port) {
  line('');
  line('--- interrogating ' + host + ':' + port + ' ---');
  line('(about 40 seconds: each attempt waits to see whether the server speaks first)');

  for (const p of ['/', '/api']) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: readable output
    const r = await httpProbe(host, port, p);
    if (r.error) { line('GET ' + p + ' -> ' + r.error); continue; }
    line('GET ' + p + ' -> HTTP ' + r.status + ' ' + r.message);
    const interesting = ['server', 'content-type', 'www-authenticate', 'allow', 'x-powered-by'];
    for (const h of interesting) if (r.headers[h]) line('        ' + h + ': ' + r.headers[h]);
    if (r.body) line('        body: ' + r.body);
  }

  // Ten attempts at the full 2.5s + 4s is over a minute of silence on screen.
  // Shorter, but still long enough that a server which greets late is not
  // mistaken for one that never greets: the phases stay in the shipped order
  // and their sum still exceeds the handshake deadline.
  const TIMING = { quietMs: 1200, rpcMs: 2500 };

  for (const p of WS_PATHS) {
    // eslint-disable-next-line no-await-in-loop -- same
    const r = await inspectWs(host, port, p, TIMING);
    line('ws ' + (p || '/') + ' -> ' + describeWs(r));
    for (const f of r.frames.slice(0, 3)) line('        frame: ' + f);
  }

  // Some servers gate on a subprotocol or refuse a browser-shaped request with
  // no Origin. Both are cheap to rule out and expensive to guess about.
  const variants = [
    { label: 'subprotocol "jsonrpc"', protocol: 'jsonrpc' },
    { label: 'subprotocol "json-rpc"', protocol: 'json-rpc' },
    { label: 'with an Origin header', wsOpts: { headers: { Origin: 'http://localhost' } } },
  ];
  for (const v of variants) {
    // eslint-disable-next-line no-await-in-loop -- same
    const r = await inspectWs(host, port, '', { ...TIMING, ...v });
    line('ws / ' + v.label + ' -> ' + describeWs(r));
    for (const f of r.frames.slice(0, 3)) line('        frame: ' + f);
  }
}

// ---- Wave Link 3 ------------------------------------------------------------
//
// Wave Link 3 is an MSIX package and PUBLISHES its port rather than picking one
// from a documented range: %LOCALAPPDATA%\Packages\Elgato.WaveLink_<hash>\
// LocalState\ws-info.json. No sweep can be relied on to find it — the number
// differs per machine and can move between launches.
//
// The handshake also carries Origin: streamdeck://, and the method vocabulary
// is new (getChannels / getMixes / getOutputDevices / setChannel), so a client
// speaking the 2.x dialect gets a socket that accepts it and then ignores every
// word — exactly what this diagnostic measured before we knew any of it.

const WL3_ORIGIN = 'streamdeck://';
const WL3_METHODS = ['getChannels', 'getMixes', 'getOutputDevices', 'getApplicationInfo'];

// Read the published port. Scans for the package folder rather than hardcoding
// the publisher hash, so a differently-signed build is still found.
export async function readPublishedPort(localAppData) {
  const base = localAppData || process.env.LOCALAPPDATA;
  if (!base) return null;
  const packages = path.join(base, 'Packages');
  let names = [];
  try { names = await fsp.readdir(packages); } catch { return null; }
  for (const name of names) {
    if (!/^Elgato\.WaveLink_/i.test(name)) continue;
    const file = path.join(packages, name, 'LocalState', 'ws-info.json');
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const data = JSON.parse(raw);
      const port = Number(data && data.port);
      if (port > 0 && port < 65536) return { port, file };
    } catch { /* try the next package */ }
  }
  return null;
}

// Speak the 3.x dialect on one socket and print what comes back verbatim. The
// raw shapes are the point: they are what an implementation has to be written
// against, and no amount of reading a client tells us what a channel looks like.
async function dialectProbe(host, port) {
  line('');
  line('--- speaking the Wave Link 3 dialect to ' + host + ':' + port + ' ---');
  const Impl = WS_IMPL.impl;
  let sock;
  try { sock = new Impl(wsUrl(host, port), { origin: WL3_ORIGIN }); }
  catch (e) { line('could not open: ' + ((e && e.message) || e)); return; }

  const pending = new Map();
  const pushes = [];
  let id = 0;

  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), WS_TIMEOUT_MS);
    sock.addEventListener('open', () => { clearTimeout(t); resolve(true); });
    sock.addEventListener('error', () => { clearTimeout(t); resolve(false); });
  });
  if (!opened) { line('the socket would not open with Origin ' + WL3_ORIGIN); return null; }
  line('connected with Origin: ' + WL3_ORIGIN);
  let appInfo = null;

  sock.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
    let msg; try { msg = JSON.parse(raw); } catch { pushes.push('non-JSON: ' + raw.slice(0, 120)); return; }
    if (msg && msg.id != null && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); p(msg); return; }
    if (msg && msg.method) pushes.push(raw.slice(0, 400));
  });

  const call = (method) => new Promise((resolve) => {
    const mine = ++id;
    const t = setTimeout(() => { pending.delete(mine); resolve(null); }, RPC_TIMEOUT_MS);
    pending.set(mine, (msg) => { clearTimeout(t); resolve(msg); });
    // The working client sends an explicit null rather than omitting `params`.
    try { sock.send(JSON.stringify({ jsonrpc: '2.0', method, params: null, id: mine })); }
    catch (e) { clearTimeout(t); pending.delete(mine); resolve(null); }
  });

  for (const method of WL3_METHODS) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: readable output
    const msg = await call(method);
    if (!msg) { line(method + ' -> no answer'); continue; }
    if (msg.error) { line(method + ' -> error ' + JSON.stringify(msg.error)); continue; }
    if (method === 'getApplicationInfo' && msg.result) appInfo = msg.result;
    const body = JSON.stringify(msg.result);
    line(method + ' -> ' + (body === undefined ? 'undefined' : body.length > 1800 ? body.slice(0, 1800) + ' ...[truncated]' : body));
  }

  if (pushes.length) {
    line('unsolicited messages while we waited:');
    for (const p of pushes.slice(0, 5)) line('    ' + p);
  } else {
    line('(no unsolicited messages)');
  }
  try { sock.close(); } catch { /* ignore */ }
  return appInfo;
}

// ---- where the client that DOES speak it lives ------------------------------
//
// A server nobody can talk to still has a client that can: Elgato's own Stream
// Deck plugin drives this same service. Naming the files says whether the
// protocol is readable (a JS bundle) or compiled, which decides whether this is
// worth pursuing at all. Names and sizes only — nothing is opened or sent.

const CLIENT_DIR_RE = /wave|volume|audio/i;
const CLIENT_FILE_RE = /\.(js|mjs|json|html|proto|md|txt)$/i;

function candidateRoots() {
  const roots = [];
  const add = (base, ...rest) => { if (base) roots.push(path.join(base, ...rest)); };
  if (process.platform === 'win32') {
    add(process.env.APPDATA, 'Elgato', 'StreamDeck', 'Plugins');
    add(process.env.PROGRAMFILES, 'Elgato');
    add(process.env['PROGRAMFILES(X86)'], 'Elgato');
  } else if (process.platform === 'darwin') {
    add(process.env.HOME, 'Library', 'Application Support', 'com.elgato.StreamDeck', 'Plugins');
    roots.push('/Applications/Wave Link.app');
  }
  return roots;
}

// `roots` is injectable so the walk can be exercised against a known tree; the
// shipped call passes nothing and uses the real locations.
export async function listCandidates(roots0) {
  line('');
  line('--- where a client that speaks this protocol might be ---');
  const roots = roots0 || candidateRoots();
  if (!roots.length) { line('(nothing to look at on ' + process.platform + ')'); return; }
  let shown = 0;
  for (const root of roots) {
    let entries;
    // eslint-disable-next-line no-await-in-loop -- sequential by design: readable output
    try { entries = await fsp.readdir(root, { withFileTypes: true }); }
    catch { continue; }
    line(root);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!CLIENT_DIR_RE.test(e.name)) continue;
      line('  ' + e.name + '/');
      let inner = [];
      // eslint-disable-next-line no-await-in-loop -- same
      try { inner = await fsp.readdir(path.join(root, e.name), { withFileTypes: true }); } catch { /* ignore */ }
      for (const f of inner) {
        if (shown >= 80) { line('    ... (truncated)'); return; }
        const kind = f.isDirectory() ? '/' : '';
        if (!kind && !CLIENT_FILE_RE.test(f.name)) continue;
        line('    ' + f.name + kind);
        shown++;
      }
    }
  }
  if (!shown) line('(no Elgato plugin or install folder found in the usual places)');
}

// ---- "then where IS it?" ----------------------------------------------------
//
// A sweep that finds nothing answers only half the question, and the other half
// is the one that decides what we fix: is Wave Link opening a local port at all,
// and if so which one? Asking the user to paste a shell one-liner for that does
// not survive the trip — the last one arrived with its `$_` eaten by Discord's
// italics and produced nothing but parser errors. So the script asks.
//
// Read-only: it lists processes and listening sockets, nothing else. Every call
// is an argv array, never a shell string.

const WL_PROC_RE = /wave|elgato/i;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 15000 },
      (err, out) => resolve(err ? '' : String(out)));
  });
}

// `tasklist /fo csv /nh` → "Image Name","PID","Session Name","Session#","Mem"
export function parseTasklist(text) {
  const byPid = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(raw.trim());
    if (m) byPid.set(m[2], m[1]);
  }
  return byPid;
}

// `netstat -ano` listening rows, IPv4 and IPv6 alike:
//   TCP    0.0.0.0:3030    0.0.0.0:0    LISTENING    22468
//   TCP    [::]:135        [::]:0       LISTENING    1452
export function parseNetstatListening(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(raw);
    if (m) rows.push({ addr: m[1], pid: m[2] });
  }
  return rows;
}

// `lsof -nP -iTCP -sTCP:LISTEN` → COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
export function parseLsofListening(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/).slice(1)) {
    const f = raw.trim().split(/\s+/);
    if (f.length < 9 || !/^\d+$/.test(f[1])) continue;
    rows.push({ name: f[0], pid: f[1], addr: f[8] });
  }
  return rows;
}

// The distinct port numbers behind a set of listening rows. A service bound to
// every interface shows up once per family ('0.0.0.0:1844' and '[::]:1844'),
// and the IPv6 spelling puts colons inside the address as well as before the
// port, so the port is read from the END and the two fold into one.
export function portsFromRows(rows) {
  const ports = [];
  for (const r of rows || []) {
    const m = /:(\d+)$/.exec(String((r && r.addr) || ''));
    const p = m ? Number(m[1]) : 0;
    if (p > 0 && p < 65536 && !ports.includes(p)) ports.push(p);
  }
  return ports;
}

// Which Wave Link processes exist, and what each one is listening on.
// Returns null where we have no read-only way to ask.
async function waveLinkSockets() {
  if (process.platform === 'win32') {
    const [tasks, netstat] = await Promise.all([
      run('tasklist', ['/fo', 'csv', '/nh']),
      run('netstat', ['-ano']),
    ]);
    const byPid = parseTasklist(tasks);
    const procs = [];
    for (const [pid, name] of byPid) if (WL_PROC_RE.test(name)) procs.push({ pid, name });
    const pids = new Set(procs.map((p) => p.pid));
    const ports = parseNetstatListening(netstat)
      .filter((r) => pids.has(r.pid))
      .map((r) => ({ ...r, name: byPid.get(r.pid) || '' }));
    return { procs, ports };
  }
  if (process.platform === 'darwin') {
    const rows = parseLsofListening(await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']));
    const ports = rows.filter((r) => WL_PROC_RE.test(r.name));
    const procs = [];
    const seen = new Set();
    for (const r of ports) if (!seen.has(r.pid)) { seen.add(r.pid); procs.push({ pid: r.pid, name: r.name }); }
    return { procs, ports };
  }
  return null;
}

// Print what Wave Link has open, and return the distinct port numbers so the
// sweep below can try them. Discovering the port beats guessing the range:
// Wave Link 3 moved its API out of Elgato.WaveLink.exe into a separate
// ElgatoAudioControlServer.exe, on a port no client was scanning.
async function reportWaveLinkSockets() {
  let info = null;
  try { info = await waveLinkSockets(); } catch { info = null; }
  line('--- what Wave Link is actually listening on ---');
  if (!info) { line('(not available on ' + process.platform + ')'); line(''); return []; }
  if (!info.procs.length) {
    line('No Wave Link process is running. Open Wave Link and run this again:');
    line('anything below is measured against an app that is not there.');
    line('');
    return [];
  }
  for (const p of info.procs) line('process ' + p.name + ' (pid ' + p.pid + ')');
  if (!info.ports.length) {
    line('None of them is listening on ANY TCP port. Wave Link is running and is');
    line('not opening a local API, so no port number would have helped.');
    line('');
    return [];
  }
  for (const r of info.ports) line('  listening ' + r.addr + '  (' + r.name + ')');
  const ports = portsFromRows(info.ports);
  const outside = ports.filter((p) => p < PORT_FROM || p > PORT_TO);
  if (outside.length) line('Outside the swept range: ' + outside.join(', ') + '. Trying them anyway.');
  line('');
  return ports;
}

async function main() {
  line('Xenon — Wave Link connection diagnostic');
  line('node ' + process.version + ' on ' + process.platform + ' | websocket via ' + WS_IMPL.name);
  line('');
  if (!WS_IMPL.impl) {
    line('No WebSocket implementation available. Run this from the Xenon install');
    line('folder (so `ws` resolves), or use Node 22 or newer.');
    process.exitCode = 1;
    return;
  }

  // Ask the OS what Wave Link has open first, so a port outside the documented
  // range still gets a JSON-RPC probe. Without this the run ends at "nothing on
  // 1824-1839", which is true and answers nothing.
  // The published port comes first: on Wave Link 3 it is the only reliable
  // answer, and the sweep exists for 2.x and for saying what is NOT there.
  const published = await readPublishedPort();
  if (published) {
    line('--- the port Wave Link 3 publishes ---');
    line(published.file);
    line('port ' + published.port);
    line('');
  }

  const discovered = await reportWaveLinkSockets();
  const PORTS = [];
  for (let p = PORT_FROM; p <= PORT_TO; p++) PORTS.push(p);
  const extras = discovered.filter((p) => !PORTS.includes(p));
  if (published && !PORTS.includes(published.port) && !extras.includes(published.port)) extras.push(published.port);
  PORTS.push(...extras);
  // The contiguous block reads as a range; anything discovered is named.
  const PORTS_LABEL = PORT_FROM + '-' + PORT_TO + (extras.length ? ' and ' + extras.join(', ') : '');

  const found = [];
  const silent = [];   // ports that opened but would not speak JSON-RPC
  for (const host of HOSTS) {
    line('--- ' + host + ' ---');
    let anyOpen = false;
    for (const port of PORTS) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design: one socket at a time, readable output
      const tcp = await tcpProbe(host, port);
      if (tcp.state !== 'open') continue;
      anyOpen = true;
      // eslint-disable-next-line no-await-in-loop -- same
      let probe = await rpcProbe(host, port, 'getApplicationInfo');
      let shape = 'no params';
      if (probe.stage !== 'ok') {
        // Some JSON-RPC servers reject a call with no `params` member at all.
        // If the bare call failed, say whether the empty-object form works.
        // eslint-disable-next-line no-await-in-loop -- same
        const retry = await rpcProbe(host, port, 'getApplicationInfo', {});
        if (retry.stage === 'ok') { probe = retry; shape = 'params: {}'; }
      }
      if (probe.stage === 'ok') {
        const info = probe.result || {};
        line('port ' + port + ': Wave Link API answered (' + shape + ')');
        line('           appName    = ' + JSON.stringify(info.appName));
        line('           appVersion = ' + JSON.stringify(info.appVersion));
        const other = Object.keys(info).filter((k) => k !== 'appName' && k !== 'appVersion');
        if (other.length) line('           other keys = ' + other.join(', '));
        found.push({ host, port, info, shape });
        // eslint-disable-next-line no-await-in-loop -- same
        const chans = await rpcProbe(host, port, 'getAllChannelInfo');
        if (chans.stage === 'ok' && Array.isArray(chans.result)) {
          line('           channels   = ' + chans.result.length
            + (chans.result.length ? ' (' + chans.result.map((c) => String(c && c.mixerName)).join(', ') + ')' : ''));
        } else {
          line('           channels   = getAllChannelInfo failed: ' + (chans.error || chans.stage));
        }
        if (probe.unsolicited.length) line('           pushes     = ' + probe.unsolicited.join(', '));
      } else {
        line('port ' + port + ': open, but not a usable Wave Link API');
        line('           failed at ' + probe.stage + ': ' + probe.error);
        // Worth a closer look, but only once per port: the same service answers
        // on both loopback families and one interrogation of it is enough.
        if (!silent.some((s) => s.port === port)) silent.push({ host, port });
      }
    }
    if (!anyOpen) line('nothing listening on ' + PORTS_LABEL);
    line('');
  }

  // A port that opened and stayed silent is the interesting case, so dig before
  // declaring anything. Skipped once a working API was found: whatever else is
  // on 182x stops mattering the moment Wave Link answers.
  // A port that refused the 2.x dialect may well answer the 3.x one, and when it
  // does the verdict has to say so: a diagnostic that prints a channel list and
  // then concludes "no API found" is worse than one that says nothing.
  const v3 = [];
  if (!found.length) {
    for (const s of silent) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design: readable output
      await deepProbe(s.host, s.port);
      // eslint-disable-next-line no-await-in-loop -- same
      const info = await dialectProbe(s.host, s.port);
      if (info) v3.push({ host: s.host, port: s.port, info });
    }
    if (!v3.length) await listCandidates();
  }

  line('');
  line('--- verdict ---');
  if (v3.length) {
    for (const f of v3) {
      const i = f.info || {};
      line('Wave Link ' + JSON.stringify(i.version || '?') + ' answered on ' + f.host + ':' + f.port
        + ' using the 3.x dialect (interfaceRevision ' + (i.interfaceRevision == null ? '?' : i.interfaceRevision) + ').');
      line('  It needs the published port, Origin: ' + WL3_ORIGIN + ', and the new method names.');
      line('  Shipped Xenon speaks the 2.x dialect on 1824-1833, so it cannot reach this.');
    }
    return;
  }
  if (!found.length) {
    line('No Wave Link API found on ' + PORTS_LABEL + '.');
    line('With Wave Link open, that means the app is not exposing a JSON-RPC API');
    line('on any port it holds (or is exposing it under a different transport).');
    process.exitCode = 2;
    return;
  }
  for (const f of found) {
    const name = String((f.info && f.info.appName) || '');
    const known = name === 'Elgato Wave Link';
    line('Wave Link API reachable at ' + f.host + ':' + f.port
      + ' — appName ' + JSON.stringify(name)
      + (known ? ' (the name Xenon expects)' : ' (NOT the name older Xenon builds expected)'));
    if (f.port > 1833) line('  Note: this port is outside the range shipped Xenon scans (1824-1833).');
    if (f.shape !== 'no params') line('  Note: this server needed "' + f.shape + '" — Xenon sends the bare form.');
    if (f.host === '::1') line('  Note: Xenon dials 127.0.0.1 first; an IPv6-only bind is worth reporting.');
  }
}

// Run only when invoked directly, so the parsers above can be imported by the
// unit test without the whole diagnostic firing.
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { line('diagnostic crashed: ' + ((e && e.stack) || e)); process.exitCode = 1; });
}
