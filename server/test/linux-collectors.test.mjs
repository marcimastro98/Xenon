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

// --- /proc/meminfo ----------------------------------------------------------
// The same trap the macOS side hit: os.freemem() is ullAvailPhys on Windows but
// MemFree here, which excludes the page cache the kernel hands straight back —
// so `total - free` counts every cached file as used. MemAvailable is the
// kernel's own answer to the question Windows was already answering.

test('parseMemInfo: used is total minus MemAvailable, not minus MemFree', () => {
  const mem = lc.parseMemInfo(fixture('linux-meminfo.txt'));
  assert.equal(mem.total, 16311476 * 1024);
  assert.equal(mem.used, (16311476 - 11238904) * 1024);
  // ~31%, against the ~97% the free-page count would have produced on a box
  // with 10 GB of page cache.
  assert.equal(Math.round((mem.used / mem.total) * 100), 31);
});

test('parseMemInfo: a kernel too old for MemAvailable falls back to free+buffers+cached', () => {
  const out = ['MemTotal:       1000000 kB', 'MemFree:         100000 kB',
    'Buffers:          50000 kB', 'Cached:         300000 kB'].join('\n');
  assert.deepEqual(lc.parseMemInfo(out), { used: 550000 * 1024, total: 1000000 * 1024 });
});

test('parseMemInfo: unusable input returns null so the caller can fall back', () => {
  for (const raw of ['', 'nothing here', 'MemFree: 100 kB', undefined]) {
    assert.equal(lc.parseMemInfo(raw), null, String(raw));
  }
  // Available above total (a kernel quirk) must not produce a negative usage.
  assert.equal(lc.parseMemInfo('MemTotal: 100 kB\nMemAvailable: 500 kB').used, 0);
});

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
  // total - free, NOT df's Used column (1271786557440 in this fixture). The two
  // differ by ext4's root-reserved blocks, which df counts in neither column.
  assert.equal(root.used, 1471786176512);
  assert.equal(root.free, 2463923310592);
  assert.equal(root.percent, 37);
  assert.equal(root.label, 'System');
  assert.equal(root.fileSystem, 'ext4');
  assert.equal(root.driveType, 'Fixed');
});

test('parseDisks: used + free always adds up to total', () => {
  // The contract tools/doctor-checks.mjs enforces, and the one an ext4 volume
  // breaks when Used is read straight from df: the tile's bar and its label are
  // drawn from these three numbers and have to agree with each other.
  for (const d of lc.parseDisks(fixture('linux-df.txt'))) {
    assert.equal(d.used + d.free, d.total, `${d.drive}: ${d.used} + ${d.free} !== ${d.total}`);
  }
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
  assert.equal(rows[0].title, 'Xenon - Google Chrome');
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

// The wmctrl-free listing path: the app switcher must work with x11-utils
// alone, since asking for a wmctrl install to READ a window list was a
// dependency the widget never needed.
test('parseClientList: every managed window id, from the root property', () => {
  const raw = '_NET_CLIENT_LIST(WINDOW): window id # 0xE00003, 0x1400007, 0x2a00005\n';
  assert.deepEqual(lc.parseClientList(raw), ['0xE00003', '0x1400007', '0x2a00005']);
  assert.deepEqual(lc.parseClientList('_NET_CLIENT_LIST:  not found.'), []);
  assert.deepEqual(lc.parseClientList(''), []);
});

test('parseWindowIdentity: the UTF-8 title wins over the latin-1 one', () => {
  // WM_NAME is latin-1, so a title with anything non-ASCII comes out mangled.
  // On a non-English desktop that is most windows.
  const raw = [
    '_NET_WM_NAME(UTF8_STRING) = "Città — Impostazioni"',
    'WM_NAME(STRING) = "Citt? ? Impostazioni"',
    '_NET_WM_PID(CARDINAL) = 4242',
  ].join('\n');
  assert.deepEqual(lc.parseWindowIdentity(raw), { pid: '4242', title: 'Città — Impostazioni' });
});

test('parseWindowIdentity: falls back to WM_NAME, and escapes come back out', () => {
  assert.deepEqual(
    lc.parseWindowIdentity('WM_NAME(STRING) = "He said \\"hi\\""\n_NET_WM_PID(CARDINAL) = 7'),
    { pid: '7', title: 'He said "hi"' });
  // A window owning neither property is an override-redirect surface, not an app.
  assert.deepEqual(lc.parseWindowIdentity('WM_NAME:  not found.'), { pid: '', title: '' });
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

// --- GPU without nvidia-smi -------------------------------------------------
// The kernel's DRM sysfs is what an AMD or Intel machine has instead. These
// snapshots are the file CONTENTS the collector reads, so the parser is testable
// off Linux; capture the real thing with
//   cat /sys/class/drm/card0/device/{uevent,gpu_busy_percent,mem_info_vram_*}
//   cat /sys/class/drm/card0/device/hwmon/hwmon*/temp1_{input,label}

test('parseSysfsGpu: an AMD card reports load, VRAM and temperature', () => {
  const g = lc.parseSysfsGpu({
    driver: 'amdgpu',
    busy: '37',
    vramUsed: '2415919104',
    vramTotal: '17163091968',
    temps: [{ value: '54000', label: 'edge' }, { value: '61000', label: 'junction' }],
  });
  assert.equal(g.gpu, 37);
  assert.equal(g.gpuTemp, 54);            // edge wins over junction
  assert.equal(g.vramUsed, 2415919104);   // bytes, like the nvidia-smi path
  assert.equal(g.vramTotal, 17163091968);
  assert.equal(g.gpuName, 'AMD GPU');
});

test('parseSysfsGpu: an Intel card reports what it has and null for the rest', () => {
  // i915 exposes no gpu_busy_percent and an integrated GPU has no separate
  // VRAM. Nulls make the tile show "--", which is the honest answer.
  const g = lc.parseSysfsGpu({ driver: 'i915', busy: null, vramUsed: null, vramTotal: null, temps: [{ value: '47000', label: null }] });
  assert.equal(g.gpu, null);
  assert.equal(g.gpuTemp, 47);
  assert.equal(g.vramUsed, null);
  assert.equal(g.gpuName, 'Intel GPU');
});

test('parseSysfsGpu: a driver already reporting degrees is not divided again', () => {
  // Dividing 54 by 1000 would report 0°C, which reads as a working sensor.
  assert.equal(lc.parseSysfsGpu({ driver: 'amdgpu', temps: [{ value: '54' }] }).gpuTemp, 54);
  assert.equal(lc.parseSysfsGpu({ driver: 'amdgpu', temps: [{ value: '54000' }] }).gpuTemp, 54);
});

test('parseSysfsGpu: junk and absent files degrade to nulls, never to zeros', () => {
  for (const snap of [undefined, null, {}, { driver: 'amdgpu', busy: 'n/a', temps: 'x' }]) {
    const g = lc.parseSysfsGpu(snap);
    assert.equal(g.gpu, null);
    assert.equal(g.gpuTemp, null);
    assert.equal(g.vramTotal, null);
  }
  // An unknown driver gets no invented name.
  assert.equal(lc.parseSysfsGpu({ driver: 'nouveau' }).gpuName, null);
  // Load is clamped, never passed through out of range.
  assert.equal(lc.parseSysfsGpu({ driver: 'amdgpu', busy: '140' }).gpu, 100);
  assert.equal(lc.parseSysfsGpu({ driver: 'amdgpu', busy: '-5' }).gpu, 0);
});

// ── Intel GPU activity from RC6 residency ───────────────────────────────────
// Intel exposes no gpu_busy_percent and its PMU needs perf permissions this
// backend does not have, so the load is derived from how much of the interval
// the render engine spent OUT of its deepest sleep state.
test('rc6Busy: the complement of the idle rate is the load', () => {
  // Half the window asleep → half awake.
  assert.equal(lc.rc6Busy({ rc6Ms: 1000, atMs: 0 }, { rc6Ms: 3000, atMs: 4000 }), 50);
  // Never slept → pegged busy. Slept the whole window → idle.
  assert.equal(lc.rc6Busy({ rc6Ms: 1000, atMs: 0 }, { rc6Ms: 1000, atMs: 4000 }), 100);
  assert.equal(lc.rc6Busy({ rc6Ms: 1000, atMs: 0 }, { rc6Ms: 5000, atMs: 4000 }), 0);
});

test('rc6Busy: the first sample has nothing to compare against', () => {
  assert.equal(lc.rc6Busy(null, { rc6Ms: 1000, atMs: 1000 }), null);
  assert.equal(lc.rc6Busy(undefined, { rc6Ms: 1, atMs: 1 }), null);
});

test('rc6Busy: a counter that went backwards is discarded, not reported', () => {
  // A driver reload or a resume restarts the counter. Treating that as "the GPU
  // idled negative time" would produce a bogus 100%.
  assert.equal(lc.rc6Busy({ rc6Ms: 9000, atMs: 0 }, { rc6Ms: 100, atMs: 4000 }), null);
});

test('rc6Busy: windows that cannot be divided meaningfully report nothing', () => {
  // Too short to sample.
  assert.equal(lc.rc6Busy({ rc6Ms: 0, atMs: 0 }, { rc6Ms: 10, atMs: 100 }), null);
  // Longer than any poll interval — the machine slept in between, and neither
  // clock ran the way the arithmetic assumes.
  assert.equal(lc.rc6Busy({ rc6Ms: 0, atMs: 0 }, { rc6Ms: 10, atMs: 600000 }), null);
});

test('rc6Busy: a residency that outruns the wall clock still clamps to 0..100', () => {
  // Reported by some drivers across a resume; the reading is nonsense but must
  // never leave the range the tile can draw.
  assert.equal(lc.rc6Busy({ rc6Ms: 0, atMs: 0 }, { rc6Ms: 99999, atMs: 4000 }), 0);
});

// ── Fans from hwmon ─────────────────────────────────────────────────────────
// No LibreHardwareMonitor and no elevation on this platform: any chip with a
// tachometer publishes fanN_input in RPM as a world-readable file.
test('parseHwmonFans: a driver label wins, otherwise the chip names the fan', () => {
  const fans = lc.parseHwmonFans([
    { chip: 'nct6798', index: 1, rpm: '1200', label: 'CPU Fan' },
    { chip: 'thinkpad', index: 1, rpm: '3877', label: '' },
    { chip: '', index: 2, rpm: '900', label: '' },
  ]);
  assert.deepEqual(fans.map((f) => f.name), ['CPU Fan', 'thinkpad fan 1', 'Fan 2']);
  assert.deepEqual(fans.map((f) => f.rpm), [1200, 3877, 900]);
  // Windows distinguishes PSU and controller fans; hwmon says nothing about
  // where a header physically is, so everything is a motherboard fan.
  assert.ok(fans.every((f) => f.kind === 'mb'));
});

test('parseHwmonFans: a stopped fan is 0 RPM, not a missing reading', () => {
  // Zero-RPM mode is a real state the tile is meant to show. Dropping it would
  // make a silent card look like a card with no sensors.
  const fans = lc.parseHwmonFans([{ chip: 'amdgpu', index: 1, rpm: '0', label: 'GPU Fan' }]);
  assert.equal(fans.length, 1);
  assert.equal(fans[0].rpm, 0);
});

test('parseHwmonFans: junk and impossible readings are dropped', () => {
  const fans = lc.parseHwmonFans([
    { chip: 'x', index: 1, rpm: '', label: '' },
    { chip: 'x', index: 2, rpm: 'n/a', label: '' },
    { chip: 'x', index: 3, rpm: '-1', label: '' },
    { chip: 'x', index: 4, rpm: '999999', label: '' },
    { chip: 'x', index: 5, rpm: '1500', label: '' },
  ]);
  assert.deepEqual(fans.map((f) => f.rpm), [1500]);
});

test('parseHwmonFans: no hwmon at all is an empty list, never a throw', () => {
  assert.deepEqual(lc.parseHwmonFans([]), []);
  assert.deepEqual(lc.parseHwmonFans(null), []);
  assert.deepEqual(lc.parseHwmonFans([null, undefined]), []);
});
