// Per-disk I/O, the other half of the SDK monitoring-widget request.
//
// Asked for on Discord: "let a widget list all detected disks and allow the
// user to select which ones to display individually" — read/write throughput,
// read/write IOPS, a stable id, the model, and the volume label or mount point.
//
// Nothing per-disk was collected on any platform, so this is three
// implementations behind one shape. These tests hold the shape, the two rules
// that make the numbers honest (a partition is not a disk; an unknown rate is
// null), and the wiring that would otherwise rot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lc = require(join(here, '..', 'linux-collectors.js'));
const dc = require(join(here, '..', 'darwin-collectors.js'));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const SERVER = read('../server.js');
const PS1 = read('../disk-io.ps1');
const SDK = read('../sdk-widgets.js');
const SETTINGS = read('../js/settings.js');
const CUSTOM = read('../js/custom-widget.js');
const I18N = read('../js/i18n.js');
const DOC = read('../../docs/WIDGET_SDK.md');

// ── Linux: /proc/diskstats ─────────────────────────────────────────────────
const DISKSTATS = [
  ' 259       0 nvme0n1 154321 0 8812345 0 98765 0 4412345 0 0 0 0',
  ' 259       1 nvme0n1p1 100 0 2000 0 50 0 1000 0 0 0 0',
  '   8       0 sda 4321 0 112233 0 765 0 44556 0 0 0 0',
  '   7       0 loop0 10 0 20 0 0 0 0 0 0 0 0',
  ' 253       0 dm-0 99 0 999 0 9 0 99 0 0 0 0',
].join('\n');

test('diskstats reads the four counters from the documented columns', () => {
  // Getting these indices wrong is the classic /proc/diskstats bug, and it is
  // invisible: the numbers still look like numbers.
  const rows = lc.parseDiskstats(DISKSTATS);
  const nvme = rows.find((r) => r.id === 'nvme0n1');
  assert.deepEqual(nvme, {
    id: 'nvme0n1', readsCompleted: 154321, sectorsRead: 8812345,
    writesCompleted: 98765, sectorsWritten: 4412345,
  });
});

test('loop, dm and friends are not disks', () => {
  const ids = lc.parseDiskstats(DISKSTATS).map((r) => r.id);
  assert.ok(!ids.includes('loop0'));
  assert.ok(!ids.includes('dm-0'));
  // The partition is still parsed here — it is filtered one level up, against
  // sysfs, because a name shape alone cannot always tell.
  assert.ok(ids.includes('nvme0n1p1'));
});

test('the mount table is read for the volume each disk carries', () => {
  const rows = lc.parseMountsFor([
    '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
    'proc /proc proc rw 0 0',
    '/dev/sda1 /mnt/my\\040backup ext4 rw 0 0',
  ].join('\n'));
  assert.deepEqual(rows, [
    { dev: 'nvme0n1p2', mount: '/', fstype: 'ext4' },
    { dev: 'sda1', mount: '/mnt/my backup', fstype: 'ext4' },
  ]);
});

test('a real machine answers with whole disks and their mounts', async () => {
  // Not a fixture: this runs against /proc on the machine running the tests.
  const disks = await lc.diskIo();
  assert.ok(Array.isArray(disks));
  for (const d of disks) {
    assert.ok(d.id && !/p\d+$/.test(d.id), 'a partition slipped through: ' + d.id);
    assert.equal(typeof d.readsCompleted, 'number');
    assert.equal(typeof d.sectorsWritten, 'number');
    assert.ok(Array.isArray(d.volumes));
    assert.ok(d.model, 'a row with no model has nothing to show for itself');
  }
});

// ── macOS: ioreg ───────────────────────────────────────────────────────────
const IOREG = `
  +-o AppleAPFSContainerScheme  <class IOBlockStorageDriver, id 0x100000abc>
      {
        "Statistics" = {"Operations (Read)"=44531,"Bytes (Read)"=2410094592,"Operations (Write)"=9915,"Bytes (Write)"=511508480,"Errors (Read)"=0}
        "BSD Name" = "disk0"
        "Product Name" = "APPLE SSD AP1024Q"
        "Serial Number" = "ABC123"
      }
  +-o External  <class IOBlockStorageDriver, id 0x100000def>
      {
        "Statistics" = {"Operations (Read)"=12,"Bytes (Read)"=4096,"Operations (Write)"=3,"Bytes (Write)"=512}
        "BSD Name" = "disk4"
        "Product Name" = "Samsung T7"
      }
  +-o NoCounters  <class IOBlockStorageDriver, id 0x100000fff>
      {
        "BSD Name" = "disk9"
      }
`;

test('ioreg gives the read/write split iostat does not', () => {
  // iostat is the obvious tool and the wrong one: on macOS it reports COMBINED
  // transfers per disk, with no read/write split, which is half the request.
  const disks = dc.parseIoregDisks(IOREG);
  assert.equal(disks.length, 2, 'an object with no Statistics is not a disk');
  assert.deepEqual(disks[0], {
    id: 'disk0', model: 'APPLE SSD AP1024Q', serial: 'ABC123',
    readsCompleted: 44531, writesCompleted: 9915,
    readBytes: 2410094592, writeBytes: 511508480,
  });
});

test('each ioreg object is parsed alone', () => {
  // Searching a window around the Statistics block instead reads the PREVIOUS
  // disk's identity fields, and every row after the first came back wearing the
  // first disk's name.
  const disks = dc.parseIoregDisks(IOREG);
  assert.equal(disks[1].id, 'disk4');
  assert.equal(disks[1].model, 'Samsung T7');
});

test('the same disk presented twice is listed once', () => {
  const twice = IOREG + IOREG;
  assert.deepEqual(dc.parseIoregDisks(twice).map((d) => d.id), ['disk0', 'disk4']);
});

// ── Windows: raw perf counters ─────────────────────────────────────────────
test('Windows reads RAW counters and lets the server do the delta', () => {
  // Win32_PerfFormattedData_* takes TWO readings inside WMI to compute a rate
  // itself: twice the cost, plus the wait. The raw counters are cumulative and
  // the delta is already being done for the network ones.
  assert.match(PS1, /Win32_PerfRawData_PerfDisk_PhysicalDisk/);
  // Code only: the comment above it names the Formatted class to say why it is
  // NOT used, and a naive search would read that as the thing it warns against.
  const code = PS1.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /Win32_PerfFormattedData/);
  // The counter's Name is "0 C:" / "1 D: E:" — index and volumes in one string,
  // so the disk→volume mapping costs no second query.
  assert.match(PS1, /\$parts = \$name\.Split\(' '/);
  assert.match(PS1, /if \(-not \$name -or \$name -eq '_Total'\) \{ continue \}/);
  // Depth matters or every nested hashtable serialises as its type name.
  assert.match(PS1, /ConvertTo-Json -Compress -Depth 4/);
});

// ── the server: rates, and what an unknown one is ──────────────────────────
test('sectors and bytes are normalised to one unit', () => {
  // Linux counts 512-byte sectors, Windows and macOS count bytes. The SDK sees
  // bytes either way, and nobody has to know which OS answered.
  const fn = SERVER.slice(SERVER.indexOf('async function _getDiskIoRaw()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /const DISK_SECTOR = 512;|\* DISK_SECTOR/);
  assert.match(body, /Number\(d\.sectorsRead\) \|\| 0\) \* DISK_SECTOR/);
  assert.match(SERVER, /const DISK_SECTOR = 512;/);
});

test('an unknown rate is null, and a disk keeps its own clock', () => {
  const fn = SERVER.slice(SERVER.indexOf('async function _getDiskIoRaw()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // Same helper the network interfaces use: no previous sample, no elapsed
  // time, or a counter that went backwards -> null, never a made-up 0.
  assert.match(body, /readBytesPerSec: bytesPerSec\(rb, prev && prev\.rb, dt\)/);
  assert.match(body, /readIops: bytesPerSec\(ro, prev && prev\.ro, dt\)/);
  assert.match(body, /const dt = prev \? \(now - prev\.t\) \/ 1000 : 0;/);
  // A disk that is unplugged stops being remembered.
  assert.match(body, /if \(!seen\.has\(id\)\) _diskPrev\.delete\(id\);/);
});

test('everything off the machine is bounded before it is stored', () => {
  const fn = SERVER.slice(SERVER.indexOf('async function _getDiskIoRaw()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /model: String\(\(d && d\.model\) \|\| id\)\.slice\(0, 120\)/);
  assert.match(body, /volumes: Array\.isArray\(d\.volumes\) \? d\.volumes\.slice\(0, 16\)/);
});

// ── the SDK surface ────────────────────────────────────────────────────────
test('diskIo is a stream, mirrored everywhere, and pulled', () => {
  assert.match(SDK, /'network', 'diskIo'/);
  assert.match(SETTINGS, /'network', 'diskIo'/,
    'settings.js keeps its own copy — a stream in one and not the other is dropped on save');
  assert.match(CUSTOM, /diskIo: \['cw_stream_diskio'/);
  const loader = CUSTOM.slice(CUSTOM.indexOf('const LOCAL_STREAM_LOADERS'));
  assert.match(loader.slice(0, 2000), /diskIo: Object\.freeze\(\{ ttl: \d+, load: async \(\) => \{/);
  assert.match(loader.slice(0, 2000), /api\('\/api\/disks\/io'\)/);
});

test('the grant is worded in every language', () => {
  const anchor = (I18N.match(/["']?cw_stream_network["']?\s*:/g) || []).length;
  assert.equal((I18N.match(/["']?cw_stream_diskio["']?\s*:/g) || []).length, anchor);
});

test('the doc says what is null and why', () => {
  assert.match(DOC, /### 3b-ter\. Per-disk I\/O/);
  assert.match(DOC, /Physical disks, not volumes/);
  assert.match(DOC, /`temperature` is `null` on Windows and macOS today/,
    'the one field that is not delivered must say so, and why');
  assert.match(DOC, /wakes a spun-down mechanical disk/);
  const ref = DOC.slice(DOC.indexOf('**Data streams** (`streams`)'));
  assert.match(ref.slice(0, 600), /`diskIo`/);
});
