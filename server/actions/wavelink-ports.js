'use strict';
// Where Wave Link listens on this PC and how long to wait for it: the hosts and ports of both
// versions, the port file Wave Link 3 publishes, and the timings of the connection.

const fsp = require('node:fs').promises;
const path = require('node:path');

// ── Wave Link 2 ──────────────────────────────────────────────────────────────
// Wave Link 2 picks the first free port from a small range, so the sweep carries
// headroom. IPv4 first (what Elgato's own client dialled), IPv6 only after that
// fails — a refused socket costs nothing, and a user whose Wave Link bound ::1
// would otherwise see "not running" forever.
const WL_HOSTS = Object.freeze(['127.0.0.1', '::1']);
const WL_START_PORT = 1824;
const WL_PORT_SPAN = 12;
// The canonical name Wave Link has reported for years. Kept as the reference
// isWaveLinkApp() is pinned against, NOT as an equality test — see that helper.
const WL_APP_NAME = 'Elgato Wave Link';

// ── Wave Link 3 ──────────────────────────────────────────────────────────────
// The app is an MSIX package and writes its port into LocalState. There is no
// range to scan: the number is ephemeral and differs per launch, so this file
// is the only reliable answer.
const WL3_ORIGIN = 'streamdeck://';
const WL3_PACKAGE_RE = /^Elgato\.WaveLink_/i;
const WL3_PORT_FILE = 'ws-info.json';
// Level meters are per subscription and the server accepts exactly these two
// kinds (output/input were refused against ids of their own kind).
const WL3_METER_TYPES = Object.freeze(['channel', 'mix']);

const IDLE_MS = 60000;
const PING_MS = 30000;
const REQ_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 1500;

// Where Wave Link 3 publishes its port. Scans for the package folder rather than
// hardcoding the publisher hash, so a differently-signed build is still found.
async function readPublishedPort(localAppData) {
  const base = localAppData || process.env.LOCALAPPDATA;
  if (!base) return null;
  const packages = path.join(base, 'Packages');
  let names = [];
  try { names = await fsp.readdir(packages); } catch (e) { return null; }
  for (const name of names) {
    if (!WL3_PACKAGE_RE.test(name)) continue;
    const file = path.join(packages, name, 'LocalState', WL3_PORT_FILE);
    try {
      const data = JSON.parse(await fsp.readFile(file, 'utf8'));
      const port = Number(data && data.port);
      if (port > 0 && port < 65536) return { port, file };
    } catch (e) { /* try the next package */ }
  }
  return null;
}

module.exports = {
  WL_HOSTS, WL_START_PORT, WL_PORT_SPAN, WL_APP_NAME, WL3_ORIGIN, WL3_PACKAGE_RE, WL3_PORT_FILE,
  WL3_METER_TYPES, IDLE_MS, PING_MS, REQ_TIMEOUT_MS, PROBE_TIMEOUT_MS, readPublishedPort,
};
