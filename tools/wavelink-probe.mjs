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
import { createRequire } from 'node:module';

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

  const found = [];
  for (const host of HOSTS) {
    line('--- ' + host + ' ---');
    let anyOpen = false;
    for (let port = PORT_FROM; port <= PORT_TO; port++) {
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
      }
    }
    if (!anyOpen) line('nothing listening on ' + PORT_FROM + '-' + PORT_TO);
    line('');
  }

  line('--- verdict ---');
  if (!found.length) {
    line('No Wave Link API found on ports ' + PORT_FROM + '-' + PORT_TO + '.');
    line('With Wave Link open, that means the app is not exposing its local API');
    line('on this range (or is exposing it under a different transport).');
    process.exitCode = 2;
    return;
  }
  for (const f of found) {
    const name = String((f.info && f.info.appName) || '');
    const known = name === 'Elgato Wave Link';
    line('Wave Link API reachable at ' + f.host + ':' + f.port
      + ' — appName ' + JSON.stringify(name)
      + (known ? ' (the name Xenon expects)' : ' (NOT the name older Xenon builds expected)'));
    if (f.port > 1833) line('  Note: this port is outside the range Xenon <= 4.11.0 scans (1824-1833).');
    if (f.shape !== 'no params') line('  Note: this server needed "' + f.shape + '" — Xenon sends the bare form.');
    if (f.host === '::1') line('  Note: Xenon dials 127.0.0.1 first; an IPv6-only bind is worth reporting.');
  }
}

main().catch((e) => { line('diagnostic crashed: ' + ((e && e.stack) || e)); process.exitCode = 1; });
