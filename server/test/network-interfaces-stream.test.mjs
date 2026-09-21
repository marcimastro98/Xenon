// Per-adapter network, for a monitoring widget built on the SDK.
//
// Asked for on Discord: "list all system network adapters instead of only the
// currently active/global traffic", with a stable id, the system's own name for
// each, and rx/tx per second — so a 10GbE NAS link, the internet link and a
// VMware VMnet can each have their own graph.
//
// The data was always there and always thrown away: all three collectors read
// every adapter and returned the SUM. These tests hold the two halves that make
// the breakdown survive — the collectors list what they used to drop, and the
// server turns each one's counters into a rate without inventing numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lc = require(join(here, '..', 'linux-collectors.js'));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const SERVER = read('../server.js');
const PS1 = read('../network.ps1');
const SDK = read('../sdk-widgets.js');
const SETTINGS = read('../js/settings.js');
const CUSTOM = read('../js/custom-widget.js');
const I18N = read('../js/i18n.js');
const DOC = read('../../docs/WIDGET_SDK.md');
const DARWIN = read('../darwin-collectors.js');

// ── the collectors list what they used to drop ─────────────────────────────
test('a virtual adapter is listed and excluded from the total', () => {
  // Real behaviour, not a source assertion: this is the case the request names.
  const out = lc.parseNetDev(
    'Inter-|\n face |\n'
    + '  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n'
    + '  vmnet8: 30 0 0 0 0 0 0 0 40 0 0 0 0 0 0 0\n'
    + '  lo: 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0\n'
  );
  assert.deepEqual(out.interfaces.map((n) => n.id), ['eth0', 'vmnet8'], 'loopback alone is dropped');
  assert.equal(out.interfaces.find((n) => n.id === 'vmnet8').kind, 'virtual');
  assert.equal(out.interfaces.find((n) => n.id === 'vmnet8').rxBytes, 30);
  // The total is the physical ones only — a VMnet or a VPN carries the same
  // packets a second time, so adding them would double-count.
  assert.equal(out.rx, 1000);
  assert.equal(out.tx, 2000);
});

test('all three platforms answer with the same shape', () => {
  for (const [name, src] of [['linux', read('../linux-collectors.js')], ['darwin', DARWIN]]) {
    assert.match(src, /kind: real \? 'physical' : 'virtual'/, name);
    assert.match(src, /rxBytes: irx, txBytes: itx/, name);
    assert.match(src, /return \{ ping, latency, rxBytes: rx, txBytes: tx, interfaces,/, name + ' network()');
  }
  // Windows is a PowerShell collector, so the same contract is asserted on it.
  assert.match(PS1, /id\s+= \[string\]\$nic\.Id/);
  assert.match(PS1, /name\s+= \[string\]\$nic\.Name/, "the user's own rename is the label");
  assert.match(PS1, /description = \[string\]\$nic\.Description/);
  assert.match(PS1, /kind\s+= \$\(if \(\$real\) \{ 'physical' \} else \{ 'virtual' \}\)/);
  assert.match(PS1, /interfaces = @\(\$ifaces\)/);
  // Depth matters: without it every hashtable in the array serialises as the
  // string "System.Collections.Hashtable" and the list arrives useless.
  assert.match(PS1, /ConvertTo-Json -Compress -Depth 3/);
  // The totals still take the physical, up adapters only.
  assert.match(PS1, /if \(\$up -and \$real\) \{ \$rx \+= \$nrx; \$tx \+= \$ntx \}/);
});

// ── the server turns counters into rates without inventing any ─────────────
test('an unknown rate is null, never zero', () => {
  // A made-up 0 draws as "idle" on a graph when the truth is "unknown" — no
  // previous sample, no elapsed time, or a counter that went backwards (an
  // interface reset, a 32-bit wrap).
  const fn = SERVER.slice(SERVER.indexOf('function bytesPerSec('));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.match(body, /if \(!prev \|\| !\(dtSec > 0\)\) return null;/);
  assert.match(body, /if \(!\(d >= 0\)\) return null;/);
});

test('each adapter keeps its own clock', () => {
  // An adapter that appears mid-session (a VPN coming up) must not inherit the
  // totals' timestamp and report a spike the size of its lifetime counter.
  assert.match(SERVER, /let _netPrevIfaces = new Map\(\);/);
  const loop = SERVER.slice(SERVER.indexOf('const interfaces = [];'));
  const body = loop.slice(0, loop.indexOf('downloadBps: downBps'));
  assert.match(body, /const prev = _netPrevIfaces\.get\(id\);/);
  assert.match(body, /const dt = prev \? \(now - prev\.t\) \/ 1000 : 0;/);
  assert.match(body, /_netPrevIfaces\.set\(id, \{ rx: nrx, tx: ntx, t: now \}\);/);
  // …and an adapter that is gone stops being remembered, or the map grows
  // forever on a machine that sees a new virtual adapter per container.
  assert.match(body, /if \(!seenIds\.has\(id\)\) _netPrevIfaces\.delete\(id\);/);
});

test('the payload carries the id, the name and both, plus the raw counters', () => {
  const loop = SERVER.slice(SERVER.indexOf('const interfaces = [];'));
  const body = loop.slice(0, loop.indexOf('downloadBps: downBps'));
  for (const field of ['id,', 'name:', 'description:', 'kind:', 'up:', 'speedBps:',
    'rxBytesPerSec:', 'txBytesPerSec:', 'rxBytes: nrx', 'txBytes: ntx']) {
    assert.ok(body.includes(field), 'missing ' + field);
  }
  // Names and descriptions come off the machine; they are bounded like every
  // other external string this file stores.
  assert.match(body, /\.slice\(0, 120\)/);
  assert.match(body, /\.slice\(0, 160\)/);
});

// ── the SDK surface ────────────────────────────────────────────────────────
test('network is a stream of its own, mirrored everywhere it has to be', () => {
  // Its own grant rather than a field on `system`: this is traffic, not a
  // sensor, and the permission dialog should say which it is.
  assert.match(SDK, /'status', 'system', 'network',/);
  assert.match(SETTINGS, /'status', 'system', 'network',/,
    'settings.js keeps its own copy of the stream list — a stream in one and not the other is dropped on save');
  assert.match(CUSTOM, /network: \['cw_stream_network'/);
});

test('it is pulled, not pushed', () => {
  // The reading costs a collector run (a PowerShell round trip on Windows, with
  // its ping). Pushed, every install would pay for a widget almost nobody has.
  const loader = CUSTOM.slice(CUSTOM.indexOf('const LOCAL_STREAM_LOADERS'));
  const spec = loader.slice(0, loader.indexOf('discordChannels:'));
  assert.match(spec, /network: Object\.freeze\(\{ ttl: \d+, load: async \(\) => \{/);
  assert.match(spec, /api\('\/network'\)/);
  assert.match(spec, /interfaces: Array\.isArray\(d\.interfaces\) \? d\.interfaces : \[\]/);
});

test('the grant is worded in every language', () => {
  const anchor = (I18N.match(/["']?cw_stream_system["']?\s*:/g) || []).length;
  assert.ok(anchor >= 11);
  assert.equal((I18N.match(/["']?cw_stream_network["']?\s*:/g) || []).length, anchor);
});

test('the doc says the things that would otherwise be found out the hard way', () => {
  assert.match(DOC, /### 3b-bis\. Per-adapter network/);
  assert.match(DOC, /`downloadBps`\/`uploadBps` stay the sum of the \*\*physical\*\* ones/);
  assert.match(DOC, /`null`, not `0`/, 'the nullability rule is the one that bites');
  assert.match(DOC, /Do not key saved settings on `name`/);
  assert.match(DOC, /PULL stream/);
  // And it is in the generated capability reference, which cannot go stale.
  const ref = DOC.slice(DOC.indexOf('**Data streams** (`streams`)'));
  assert.match(ref.slice(0, 600), /`network`/);
});
