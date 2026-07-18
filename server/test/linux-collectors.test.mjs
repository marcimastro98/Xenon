'use strict';
// linux-collectors.js parsing — the pure functions behind the Linux collectors.
// Fixtures in test/fixtures/ are real output captured from a Linux box (Ubuntu
// 24.04, X11, PipeWire), so these lock the contracts the Windows collectors
// define: df's drive shape, /proc/net/dev's cumulative counters, wmctrl's
// column layout, and pw-dump's cubic volume scale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const lc = require('../linux-collectors.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

// --- df ---------------------------------------------------------------------

test('parseDisks: keeps real filesystems and drops pseudo/virtual mounts', () => {
  const drives = lc.parseDisks(fixture('linux-df.txt'));
  const mounts = drives.map((d) => d.drive).sort();
  assert.deepEqual(mounts, ['/', '/boot/efi']);
  // every tmpfs, efivarfs and /run mount in the fixture is filtered out
  assert.ok(!drives.some((d) => d.fileSystem === 'tmpfs'));
  assert.ok(!drives.some((d) => d.drive.startsWith('/run')));
});

test('parseDisks: bytes and percent match the Windows drive shape', () => {
  const root = lc.parseDisks(fixture('linux-df.txt')).find((d) => d.drive === '/');
  assert.equal(root.total, 3935709487104);
  assert.equal(root.used, 1271786557440);
  assert.equal(root.free, 2463923310592);
  assert.equal(root.percent, 32);
  assert.equal(root.label, 'System');
  assert.equal(root.fileSystem, 'ext4');
  assert.equal(root.driveType, 'Fixed');
});

test('parseDisks: keeps every subvolume of a shared device', () => {
  // btrfs (and LVM-thin, and ZFS) mount several subvolumes from ONE source.
  // Deduping on the device alone dropped every mount after the first, so /home
  // vanished on the common /-plus-/home-on-one-disk layout.
  const df = [
    'Filesystem Mounted-on Type 1B-blocks Used Avail',
    '/dev/nvme0n1p2 / btrfs 500107862016 120000000000 380107862016',
    '/dev/nvme0n1p2 /home btrfs 500107862016 120000000000 380107862016',
    '/dev/nvme0n1p1 /boot/efi vfat 1124999168 39997440 1085001728',
  ].join('\n');
  assert.deepEqual(lc.parseDisks(df).map((d) => d.drive), ['/', '/home', '/boot/efi']);
});

test('parseDisks: still collapses a genuinely repeated row', () => {
  const df = [
    'Filesystem Mounted-on Type 1B-blocks Used Avail',
    '/dev/sda1 / ext4 100 40 60',
    '/dev/sda1 / ext4 100 40 60',
  ].join('\n');
  assert.equal(lc.parseDisks(df).length, 1);
});

test('parseDisks: tolerates empty or header-only input', () => {
  assert.deepEqual(lc.parseDisks(''), []);
  assert.deepEqual(lc.parseDisks('Filesystem Mounted on Type 1B-blocks Used Avail'), []);
});

// --- /proc/net/dev ----------------------------------------------------------

test('parseNetDev: sums physical interfaces only', () => {
  const { rx, tx } = lc.parseNetDev(fixture('linux-proc-net-dev.txt'));
  // wlp109s0 alone; lo, virbr0 and the idle enp113s0 contribute nothing.
  assert.equal(rx, 27410523);
  assert.equal(tx, 36255770);
});

test('parseNetDev: rx is field 0 and tx is field 8 after the colon', () => {
  // A single made-up interface makes the column offsets explicit: getting these
  // two indices wrong is the classic /proc/net/dev bug.
  const line = 'Inter-|\n face |\n  eth9: 111 2 0 0 0 0 0 0 999 3 0 0 0 0 0 0\n';
  assert.deepEqual(lc.parseNetDev(line), { rx: 111, tx: 999 });
});

test('parseNetDev: tolerates missing file content', () => {
  assert.deepEqual(lc.parseNetDev(''), { rx: 0, tx: 0 });
});

// --- ping -------------------------------------------------------------------

test('parsePing: ping is the average RTT and latency is the jitter', () => {
  const out = 'rtt min/avg/max/mdev = 6.824/12.132/18.362/4.755 ms';
  assert.deepEqual(lc.parsePing(out), { ping: 12, latency: 12 }); // 18.362 - 6.824
});

test('parsePing: unreachable host yields nulls, not zeros', () => {
  assert.deepEqual(lc.parsePing('3 packets transmitted, 0 received'), { ping: null, latency: null });
});

// --- wmctrl -----------------------------------------------------------------

test('parseWmctrl: splits the four fixed columns and keeps the rest as title', () => {
  const rows = lc.parseWmctrl(fixture('linux-wmctrl.txt'));
  assert.equal(rows.length, 5);
  assert.equal(rows[0].hexId, '0x02600004');
  assert.equal(rows[0].pid, '10106');
  assert.equal(rows[0].dec, 0x02600004);
  assert.equal(rows[0].title, 'Xenon Edge Control - Google Chrome');
});

test('parseWmctrl: titles with spaces and RTL text survive intact', () => {
  const rows = lc.parseWmctrl(fixture('linux-wmctrl.txt'));
  const rtl = rows.find((r) => r.hexId === '0x0400001c');
  assert.ok(rtl.title.includes('Mountain View North Coast'));
  assert.ok(rtl.title.endsWith('Facebook - Google Chrome‬‎'));
});

// A Windows checkout with core.autocrlf=true rewrites the fixtures, and `\r` is
// a line terminator in JS regex, so `.` will not match it: a CRLF row fails a
// `$`-anchored pattern outright and the parser returns nothing at all. These two
// pin the tolerance so the suite passes on Windows as well as Linux.
const toCRLF = (s) => s.replace(/\r?\n/g, '\r\n');

test('parseWmctrl: CRLF input parses identically to LF', () => {
  const lf = lc.parseWmctrl(fixture('linux-wmctrl.txt'));
  const crlf = lc.parseWmctrl(toCRLF(fixture('linux-wmctrl.txt')));
  assert.equal(crlf.length, lf.length);
  assert.ok(crlf.length > 0, 'CRLF input must not parse to zero rows');
  assert.deepEqual(crlf, lf);
});

test('parseDisks, parseNetDev and parseGpu also tolerate CRLF', () => {
  assert.deepEqual(lc.parseDisks(toCRLF(fixture('linux-df.txt'))), lc.parseDisks(fixture('linux-df.txt')));
  assert.deepEqual(lc.parseNetDev(toCRLF(fixture('linux-proc-net-dev.txt'))), lc.parseNetDev(fixture('linux-proc-net-dev.txt')));
  assert.deepEqual(lc.parseGpu('11, 45, 1653, 32607, NVIDIA GeForce RTX 5090\r\n'), lc.parseGpu('11, 45, 1653, 32607, NVIDIA GeForce RTX 5090\n'));
});

test('parseWmctrl: skips untitled and malformed rows', () => {
  assert.deepEqual(lc.parseWmctrl('0x00000001  0 123  host   \nnot a window row\n'), []);
});

// --- xprop ------------------------------------------------------------------

test('parseWindowProps: takes the class, not the instance, and reads hidden state', () => {
  const out = 'WM_CLASS(STRING) = "google-chrome", "Google-chrome"\n' +
              '_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN, _NET_WM_STATE_SKIP_TASKBAR\n';
  assert.deepEqual(lc.parseWindowProps(out), { minimized: true, cls: 'Google-chrome' });
});

test('parseWindowProps: a visible window is not minimized', () => {
  const out = 'WM_CLASS(STRING) = "evince", "Evince"\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_FOCUSED\n';
  assert.deepEqual(lc.parseWindowProps(out), { minimized: false, cls: 'Evince' });
});

test('parseWindowProps: missing properties degrade to an empty class', () => {
  assert.deepEqual(lc.parseWindowProps(null), { minimized: false, cls: '' });
});

// --- pw-dump ----------------------------------------------------------------

test('cubicToLinear: PipeWire stores cubic volume, wpctl shows its cube root', () => {
  // Reading channelVolumes raw would report 7% for a sink actually at 42%.
  assert.equal(Math.round(lc.cubicToLinear(0.074808) * 100), 42);
  assert.equal(Math.round(lc.cubicToLinear(0.226982) * 100), 61);
  assert.equal(Math.round(lc.cubicToLinear(1) * 100), 100);
  assert.equal(lc.cubicToLinear(0), 0);
});

test('parsePwDump: classifies nodes and resolves the default sink and source', () => {
  const n = lc.parsePwDump(fixture('linux-pw-dump.json'));
  assert.equal(n.sinks.length, 1);
  assert.equal(n.sources.length, 1);
  assert.equal(n.sinks[0].desc, 'Jabra Evolve2 40 SE Analog Stereo');
  assert.ok(n.defSink.length > 0);
  assert.ok(n.defSource.length > 0);
});

test('parsePwDump: volume comes back on the 0-100 scale the mixer displays', () => {
  const n = lc.parsePwDump(fixture('linux-pw-dump.json'));
  assert.equal(n.sinks[0].volume, 61);   // channelVolumes 0.226982
  assert.equal(n.sinks[0].muted, false);
});

test('parsePwDump: rejects unparseable output instead of pretending it is empty', () => {
  assert.equal(lc.parsePwDump('not json'), null);
  assert.equal(lc.parsePwDump('{"not":"an array"}'), null);
});

// --- SoundVolumeView row layout ---------------------------------------------

test('buildAudioRows: devices land in SoundVolumeView column positions', () => {
  const n = lc.parsePwDump(fixture('linux-pw-dump.json'));
  const rows = lc.buildAudioRows(n);
  const sink = rows.find((r) => r[1] === 'Device' && r[2] === 'Render');
  assert.equal(sink.length, 22);
  assert.equal(sink[0], 'Jabra Evolve2 40 SE Analog Stereo'); // NAME
  assert.equal(sink[7], 'Active');                            // STATE
  assert.equal(sink[8], 'No');                                // MUTED
  assert.equal(sink[10], '61');                               // VOL_PCT
  assert.equal(sink[18], '55');                               // CLI_ID = node id
});

test('buildAudioRows: app rows carry a bare binary name in PROC_PATH', () => {
  const n = lc.parsePwDump(fixture('linux-pw-dump.json'));
  const app = lc.buildAudioRows(n).find((r) => r[1] === 'Application');
  if (!app) return; // fixture may carry no live stream
  assert.ok(!app[19].includes('/'), 'PROC_PATH must have no path separator');
  assert.ok(!app[19].includes('\\'), 'server splits on backslash and takes the tail');
});

// --- write-target resolution ------------------------------------------------

const NODES = {
  defSink: 'sink-a', defSource: 'source-a',
  sinks: [{ id: 10, name: 'sink-a' }, { id: 11, name: 'sink-b' }],
  sources: [{ id: 20, name: 'source-a' }],
  outStreams: [
    { id: 30, binary: 'obs', appName: 'OBS Studio' },
    { id: 31, binary: 'obs', appName: 'OBS Studio' },
    { id: 32, binary: 'chrome', appName: 'Chromium' },
  ],
  inStreams: [],
};

test('resolveTargets: a numeric id passes through', () => {
  assert.deepEqual(lc.resolveTargets(NODES, '30'), [30]);
});

test('resolveTargets: the SVV default-device selectors map to the defaults', () => {
  assert.deepEqual(lc.resolveTargets(NODES, 'DefaultRenderDevice'), [10]);
  assert.deepEqual(lc.resolveTargets(NODES, 'DefaultCaptureDevice'), [20]);
});

test('resolveTargets: an app name matches every stream it owns', () => {
  // One app can hold several streams; muting must hit all of them, which is the
  // behaviour SoundVolumeView has on Windows.
  assert.deepEqual(lc.resolveTargets(NODES, 'obs.exe'), [30, 31]);
  assert.deepEqual(lc.resolveTargets(NODES, 'obs'), [30, 31]);
});

test('resolveTargets: no match returns empty so the caller can report failure', () => {
  assert.deepEqual(lc.resolveTargets(NODES, 'notrunning.exe'), []);
});

// --- GPU --------------------------------------------------------------------

test('parseGpu: converts MiB to bytes and keeps commas in the model name', () => {
  const g = lc.parseGpu('11, 45, 1653, 32607, NVIDIA GeForce RTX 5090\n');
  assert.equal(g.gpu, 11);
  assert.equal(g.gpuTemp, 45);
  assert.equal(g.vramUsed, 1653 * 1048576);
  assert.equal(g.vramTotal, 32607 * 1048576);
  assert.equal(g.gpuName, 'NVIDIA GeForce RTX 5090');
});

test('parseGpu: a short or empty row yields nulls, never NaN', () => {
  for (const out of ['', 'garbage', '1, 2']) {
    const g = lc.parseGpu(out);
    assert.equal(g.gpu, null);
    assert.equal(g.vramTotal, null);
  }
});
