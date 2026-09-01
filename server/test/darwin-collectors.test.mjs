'use strict';
// darwin-collectors.js parsing — the pure functions behind the macOS collectors.
// These lock the same contracts the Windows collectors define, the way the
// Linux suite does: df's drive shape, cumulative interface counters, and the
// SoundVolumeView column layout the whole audio path is written against.
//
// The darwin-* fixtures are written to each tool's documented output format
// rather than captured from a machine (this repo is developed on Windows), and
// they describe hardware no single Mac has all of — that is why they stay. The
// darwin-real-* set alongside them IS a verbatim capture (MacBook Air M2,
// macOS 26.5.2), so the format is pinned by more than a reading of the docs;
// every parser here was confirmed against it. Re-capture with
// `npm run doctor -- --capture <dir>`, or by hand, in order:
//   df -k -P -l                          > darwin-df.txt
//   mount                                > darwin-mount.txt
//   netstat -ib                          > darwin-netstat-ib.txt
//   macmon pipe -s 1                     > darwin-macmon.jsonl
//   system_profiler SPDisplaysDataType -json > darwin-displays.json
//   system_profiler SPAudioDataType -json    > darwin-audio.json
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const dc = require('../darwin-collectors.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

// --- real machine output ----------------------------------------------------
// The darwin-* fixtures above are written to each tool's documented format and
// describe machines this one is not (two audio outputs, a Mac with discrete
// VRAM), which is why they stay. These are the same commands captured verbatim
// from a real machine — MacBook Air M2, macOS 26.5.2, `npm run doctor
// --capture` — so the FORMAT is pinned by something nobody wrote by hand. They
// carry rows no synthetic fixture had: df's `devfs` and `map auto_home`, which
// are not filesystems the disks tile should ever show.
//
// Asserted by shape and invariant rather than by value: the point is that real
// output parses, and re-capturing on another Mac must not mean rewriting
// assertions.

test('real macOS output: df + mount yield only mountable volumes', () => {
  const drives = dc.parseDisks(fixture('darwin-real-df.txt'), dc.parseMountTypes(fixture('darwin-real-mount.txt')));
  assert.ok(drives.length >= 1, 'the boot volume at least');
  assert.equal(drives[0].drive, '/');
  for (const d of drives) {
    // Never the APFS role volumes, the automounter, or devfs.
    assert.ok(!d.drive.startsWith('/System/Volumes/'), `role volume leaked: ${d.drive}`);
    assert.notEqual(d.drive, '/dev');
    assert.ok(d.total > 0 && d.used >= 0 && d.free >= 0, `implausible sizes for ${d.drive}`);
    assert.equal(d.used + d.free, d.total, `used+free must equal total for ${d.drive}`);
    assert.ok(d.percent >= 0 && d.percent <= 100);
    assert.ok(d.fileSystem, `no filesystem type for ${d.drive}`);
  }
});

test('real macOS output: netstat, displays and audio parse into the shapes server.js reads', () => {
  const net = dc.parseNetstatIb(fixture('darwin-real-netstat-ib.txt'));
  assert.ok(net.rx > 0 && net.tx > 0, 'cumulative counters since boot');
  assert.ok(Number.isInteger(net.rx) && Number.isInteger(net.tx));

  const gpu = dc.parseDisplaysJson(fixture('darwin-real-displays.json'));
  assert.ok(gpu.gpuName, 'Apple Silicon still names itself');
  // Unified memory: no discrete VRAM to report, and 0 would read as a reading.
  assert.equal(gpu.vramTotal, null);

  const audio = dc.parseAudioDevices(fixture('darwin-real-audio.json'));
  assert.ok(audio.outputs.length >= 1 && audio.inputs.length >= 1);
  assert.equal(audio.outputs.filter((d) => d.isDefault).length, 1, 'exactly one default output');
  assert.equal(audio.inputs.filter((d) => d.isDefault).length, 1, 'exactly one default input');
});

// --- vm_stat ----------------------------------------------------------------
// os.freemem() is ullAvailPhys on Windows and the Mach free_count here, and
// macOS keeps the latter near zero on purpose: `total - free` reported 99% used
// on an idle machine and stayed there. These pin Activity Monitor's own
// definition — App Memory + Wired + Compressed — so the tile shows a number the
// user can check against Apple's tool.

test('parseVmStat: used is App Memory + Wired + Compressed, not total minus free', () => {
  const total = 8 * 1024 ** 3;
  const mem = dc.parseVmStat(fixture('darwin-vm-stat.txt'), total);
  assert.equal(mem.total, total);
  // The captured machine is a genuinely busy 8 GB M2. The precise figure is
  // whatever the fixture holds; what must hold is that it is a real reading and
  // not the degenerate "everything is used" the free-page count produces.
  const pct = Math.round((mem.used / mem.total) * 100);
  assert.ok(pct > 30 && pct < 95, `implausible usage: ${pct}%`);
});

test('parseVmStat: the arithmetic is exact, page size included', () => {
  // 4 KB pages here, deliberately not the 16 KB of Apple Silicon, so a
  // hard-coded page size cannot pass: anonymous 1000 - purgeable 100 = 900,
  // plus wired 500 plus compressor 200 = 1600 pages * 4096 = 6553600.
  const out = [
    'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
    'Pages free:                               50.',
    'Pages wired down:                        500.',
    'Pages purgeable:                         100.',
    'Anonymous pages:                        1000.',
    'Pages occupied by compressor:            200.',
  ].join('\n');
  assert.deepEqual(dc.parseVmStat(out, 64 * 1024 * 1024), { used: 6553600, total: 67108864 });
});

test('parseVmStat: an older vm_stat without the compressor line still reports', () => {
  // Treating the missing field as zero understates by that much, which beats
  // refusing to report and blanking the tile.
  const out = [
    'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
    'Pages wired down:                        500.',
    'Anonymous pages:                        1000.',
  ].join('\n');
  assert.deepEqual(dc.parseVmStat(out, 64 * 1024 * 1024), { used: 6144000, total: 67108864 });
});

test('parseVmStat: unreadable output returns null so the caller can fall back', () => {
  for (const raw of ['', 'not vm_stat output', undefined]) {
    assert.equal(dc.parseVmStat(raw, 8 * 1024 ** 3), null, String(raw));
  }
  // No total means no percentage worth showing.
  assert.equal(dc.parseVmStat(fixture('darwin-vm-stat.txt'), 0), null);
  // Never more than the machine has, whatever the arithmetic says.
  const huge = 'page size of 4096 bytes\nPages wired down: 99999999.\nAnonymous pages: 99999999.';
  assert.equal(dc.parseVmStat(huge, 1024).used, 1024);
});

// --- df + mount -------------------------------------------------------------

test('parseDisks: keeps / and real volumes, drops the APFS role volumes', () => {
  const drives = dc.parseDisks(fixture('darwin-df.txt'), dc.parseMountTypes(fixture('darwin-mount.txt')));
  assert.deepEqual(drives.map((d) => d.drive).sort(), ['/', '/Volumes/Backup Drive']);
  // Preboot/VM/Update/Data all share one container with / — listing them would
  // show the same disk five times.
  assert.ok(!drives.some((d) => d.drive.startsWith('/System/Volumes')));
});

test('parseDisks: used is total - free, not df\'s Used column', () => {
  const [root] = dc.parseDisks(fixture('darwin-df.txt'), dc.parseMountTypes(fixture('darwin-mount.txt')));
  assert.equal(root.drive, '/');
  assert.equal(root.total, 971350180 * 1024);
  assert.equal(root.free, 114352188 * 1024);
  // df's own Used column for / is the 10 GB sealed system volume. Trusting it
  // would report an 88%-full disk as 1% full.
  assert.equal(root.used, root.total - root.free);
  assert.equal(root.percent, 88);
});

test('parseDisks: labels, filesystem types and drive type', () => {
  const drives = dc.parseDisks(fixture('darwin-df.txt'), dc.parseMountTypes(fixture('darwin-mount.txt')));
  const root = drives.find((d) => d.drive === '/');
  const ext = drives.find((d) => d.drive !== '/');
  assert.equal(root.label, 'System');
  assert.equal(root.fileSystem, 'apfs');
  assert.equal(root.driveType, 'Fixed');
  // A mount point with a space must survive: the mount point is the rest of the
  // line, not the next whitespace-delimited field.
  assert.equal(ext.label, 'Backup Drive');
  assert.equal(ext.fileSystem, 'hfs');
  assert.equal(ext.driveType, 'Removable');
});

test('parseMountTypes: maps mount points to filesystems and ignores automount rows', () => {
  const types = dc.parseMountTypes(fixture('darwin-mount.txt'));
  assert.equal(types.get('/'), 'apfs');
  assert.equal(types.get('/dev'), 'devfs');
  assert.equal(types.get('/Volumes/Backup Drive'), 'hfs');
  assert.equal(types.get('/System/Volumes/Data/home'), undefined);
});

// --- netstat ----------------------------------------------------------------

test('parseNetstatIb: sums the link rows of physical interfaces only', () => {
  const { rx, tx } = dc.parseNetstatIb(fixture('darwin-netstat-ib.txt'));
  // en0's <Link#6> row alone. lo0/awdl0/utun0 are virtual, and en0's per-address
  // row repeats the same counters — counting it would double every reading.
  assert.equal(rx, 1834729481);
  assert.equal(tx, 184729481);
});

test('parseNetstatIb: an interface with no hardware address never shifts a column', () => {
  // lo0's link row has an empty Address field, so whitespace splitting moves
  // Ibytes one field left. It is filtered as virtual, which is what keeps the
  // shorter row from being read as an ordinary one.
  const out = dc.parseNetstatIb('Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll\nlo0   16384 <Link#1>                          6234     0     512340     6234     0     512340     0\n');
  assert.deepEqual(out, { rx: 0, tx: 0 });
});

// --- macmon -----------------------------------------------------------------

test('parseMacmon: reads the nested temp block and the scalar gpu ratio', () => {
  const s = dc.parseMacmon(fixture('darwin-macmon.jsonl'));
  assert.equal(s.cpuTemp, 48.5);
  assert.equal(s.gpuTemp, 42.3);
  assert.equal(s.gpu, 37); // 0.37 ratio → percent
});

test('parseMacmon: the older flat/tuple payload still reads', () => {
  // macmon moved temps under `temp` and replaced gpu_usage: [freq, ratio] with a
  // scalar. Pinning one layout would turn every reading null on an upgrade.
  const s = dc.parseMacmon(fixture('darwin-macmon-legacy.jsonl'));
  assert.equal(s.cpuTemp, 55);
  assert.equal(s.gpuTemp, 50);
  assert.equal(s.gpu, 42);
  // The tuple's first element is the live clock in MHz. It is free to read —
  // the sample was parsed for the ratio anyway — so the monitoring widgets get
  // a CPU and GPU clock on Apple Silicon rather than a blank where Windows has
  // a number. This fixture reports only the efficiency cluster.
  assert.equal(s.gpuClockMHz, 700);
  assert.equal(s.cpuClockMHz, 1100);
});

test('parseMacmon: the performance cluster is the CPU clock when both are reported', () => {
  // "CPU clock" on a monitor means the fast cluster; an average across clusters
  // reads low whenever macOS is parking work on the efficiency cores, which on
  // an idle machine is most of the time. Same rule as the fastest-core pick on
  // Windows and Linux.
  const s = dc.parseMacmon('{"ecpu_usage":[1100,0.2],"pcpu_usage":[3400,0.6],"gpu_usage":[900,0.1]}');
  assert.equal(s.cpuClockMHz, 3400);
  assert.equal(s.gpuClockMHz, 900);
});

test('parseMacmon: a build reporting a bare ratio leaves the clock null, not zero', () => {
  const s = dc.parseMacmon('{"gpu_usage_ratio":0.5,"cpu_temp_avg":40}');
  assert.equal(s.gpu, 50);
  assert.equal(s.cpuClockMHz, null);
  assert.equal(s.gpuClockMHz, null);
});

test('parseMacmon: garbage and partial lines degrade to nulls', () => {
  const nothing = { cpuTemp: null, gpu: null, gpuTemp: null, cpuClockMHz: null, gpuClockMHz: null };
  assert.deepEqual(dc.parseMacmon(''), nothing);
  assert.deepEqual(dc.parseMacmon('not json'), nothing);
  // A truncated final line must not discard the complete sample before it.
  const s = dc.parseMacmon(fixture('darwin-macmon.jsonl').trim() + '\n{"temp":{"cpu_te');
  assert.equal(s.cpuTemp, 48.5);
});

test('ratioToPct: accepts both the 0..1 ratio and the deprecated percent', () => {
  assert.equal(dc.ratioToPct(0.5), 50);
  assert.equal(dc.ratioToPct(73), 73);
  assert.equal(dc.ratioToPct(null), null);
});

// --- system_profiler --------------------------------------------------------

test('parseDisplaysJson: Apple Silicon reports a name and no discrete VRAM', () => {
  const g = dc.parseDisplaysJson(fixture('darwin-displays.json'));
  assert.equal(g.gpuName, 'Apple M3 Pro');
  // Unified memory: there is no separate VRAM figure, and inventing one from
  // system RAM would be a wrong number rather than a missing one.
  assert.equal(g.vramTotal, null);
});

test('parseDisplaysJson: a discrete card reports VRAM in bytes', () => {
  const g = dc.parseDisplaysJson(fixture('darwin-displays-discrete.json'));
  assert.equal(g.gpuName, 'AMD Radeon Pro 5500M');
  assert.equal(g.vramTotal, 8 * 1073741824);
});

test('parseDisplaysJson: on a switchable-graphics Mac the discrete card wins', () => {
  // 2016-2020 Intel MacBook Pros list BOTH GPUs, integrated first. The card
  // with dedicated VRAM (spdisplays_vram — an iGPU only ever reports
  // spdisplays_vram_shared) is the one every other platform's GPU tile shows.
  const doc = JSON.stringify({ SPDisplaysDataType: [
    { _name: 'Intel UHD Graphics 630', sppci_model: 'Intel UHD Graphics 630', spdisplays_vram_shared: '1536 MB' },
    { _name: 'Radeon Pro 5500M', sppci_model: 'AMD Radeon Pro 5500M', spdisplays_vram: '8 GB' },
  ] });
  const g = dc.parseDisplaysJson(doc);
  assert.equal(g.gpuName, 'AMD Radeon Pro 5500M');
  assert.equal(g.vramTotal, 8 * 1073741824);
});

test('parseAudioDevices: splits outputs from inputs and marks the defaults', () => {
  const d = dc.parseAudioDevices(fixture('darwin-audio.json'));
  assert.deepEqual(d.outputs.map((x) => x.name), ['MacBook Pro Speakers', 'Studio Display Speakers']);
  assert.deepEqual(d.inputs.map((x) => x.name), ['MacBook Pro Microphone']);
  assert.equal(d.outputs.find((x) => x.isDefault).name, 'MacBook Pro Speakers');
  assert.equal(d.inputs.find((x) => x.isDefault).name, 'MacBook Pro Microphone');
});

// --- audio rows (the SoundVolumeView contract) ------------------------------

const F = { NAME: 0, TYPE: 1, DIR: 2, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18 };

test('parseVolumeSettings: reads the osascript summary line', () => {
  const v = dc.parseVolumeSettings('output volume:50, input volume:75, alert volume:100, output muted:false');
  assert.deepEqual(v, { output: 50, input: 75, muted: false });
  assert.equal(dc.parseVolumeSettings('output volume:0, input volume:0, alert volume:100, output muted:true').muted, true);
});

test('buildAudioRows: device rows carry the columns server.js indexes', () => {
  const devices = dc.parseAudioDevices(fixture('darwin-audio.json'));
  const rows = dc.buildAudioRows(devices, { output: 50, input: 75, muted: false });
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.length, 22);       // the /scomma layout, unchanged
    assert.equal(r[F.TYPE], 'Device');
    assert.equal(r[F.STATE], 'Active'); // _getAudioInfoRaw filters on this
  }
  const spk = rows.find((r) => r[F.NAME] === 'MacBook Pro Speakers');
  assert.equal(spk[F.DIR], 'Render');
  assert.equal(spk[F.DEFAULT], 'Render');
  assert.equal(spk[F.VOL_PCT], '50');
  assert.equal(spk[F.CLI_ID], 'MacBook Pro Speakers'); // the name is the id
  const mic = rows.find((r) => r[F.DIR] === 'Capture');
  assert.equal(mic[F.VOL_PCT], '75');
  assert.equal(mic[F.MUTED], 'No');
});

test('buildAudioRows: a non-default device reports no volume rather than a borrowed one', () => {
  const devices = dc.parseAudioDevices(fixture('darwin-audio.json'));
  const rows = dc.buildAudioRows(devices, { output: 50, input: 75, muted: false });
  const other = rows.find((r) => r[F.NAME] === 'Studio Display Speakers');
  assert.equal(other[F.DEFAULT], '');
  assert.equal(other[F.VOL_PCT], '');
});

test('buildAudioRows: a muted mic is one held at zero', () => {
  const devices = dc.parseAudioDevices(fixture('darwin-audio.json'));
  const rows = dc.buildAudioRows(devices, { output: 50, input: 0, muted: false });
  const mic = rows.find((r) => r[F.DIR] === 'Capture');
  assert.equal(mic[F.MUTED], 'Yes');
});

test('isCaptureTarget: routes the default selectors and named devices', () => {
  const devices = dc.parseAudioDevices(fixture('darwin-audio.json'));
  assert.equal(dc.isCaptureTarget('DefaultCaptureDevice', devices), true);
  assert.equal(dc.isCaptureTarget('DefaultRenderDevice', devices), false);
  assert.equal(dc.isCaptureTarget('MacBook Pro Microphone', devices), true);
  assert.equal(dc.isCaptureTarget('Studio Display Speakers', devices), false);
});

test('isCaptureTarget: the stand-in names route the same way the rows do', () => {
  // system_profiler denied or absent: the rows fall back to two placeholder
  // devices, and server.js caches THOSE names as the mic/speaker id. Classified
  // against the raw (empty) enumeration, a mic mute read as an output write and
  // muted the speakers while leaving the microphone live.
  const empty = { outputs: [], inputs: [] };
  const rows = dc.buildAudioRows(empty, { output: 40, input: 60, muted: false });
  const micId = rows.find((r) => r[F.DIR] === 'Capture')[F.CLI_ID];
  const spkId = rows.find((r) => r[F.DIR] === 'Render')[F.CLI_ID];
  assert.equal(dc.isCaptureTarget(micId, empty), true);
  assert.equal(dc.isCaptureTarget(spkId, empty), false);
});

// --- app switcher -----------------------------------------------------------

test('parseAppList: builds the /windows contract and hides the shell', () => {
  const list = dc.parseAppList(fixture('darwin-apps.txt'));
  assert.deepEqual(list.map((w) => w.app), ['Safari', 'Terminal']);
  // Finder is in the fixture: quitting it takes the desktop down.
  assert.ok(!list.some((w) => w.app === 'Finder'));
  const safari = list[0];
  assert.equal(safari.id, '501');            // server.js validates /^\d{1,24}$/
  assert.equal(safari.title, 'Xenon on GitHub');
  assert.equal(safari.path, '/Applications/Safari.app');
  assert.equal(safari.active, true);
  assert.equal(safari.minimized, false);
  assert.equal(safari.icon, null);
});

test('parseAppList: the close path can still see the shell it must refuse', () => {
  // Filtered out of the list, kept for the lookup: a quit aimed at Finder has
  // to answer "protected", and it cannot if the row was already dropped.
  const all = dc.parseAppList(fixture('darwin-apps.txt'), true);
  assert.ok(all.some((w) => w.app === 'Finder'));
});

test('parseAppList: an app with no open window falls back to its own name', () => {
  const list = dc.parseAppList('900\tMail\t/Applications/Mail.app\tfalse\t\n');
  assert.equal(list[0].title, 'Mail');
});

test('parseAppList: rows without a usable process id are dropped', () => {
  const list = dc.parseAppList('\t\t\t\nnotapid\tThing\t/x.app\tfalse\t\n42\tOK\t/ok.app\tfalse\t\n');
  assert.deepEqual(list.map((w) => w.id), ['42']);
});

// ── the native helper's `temps` mode ────────────────────────────────────────
// GPU load from IOKit's public accelerator registry, temperatures from the HID
// sensor services. Preferred over macmon because it needs nothing installed;
// the parser's job is to make sure a partial answer falls THROUGH to macmon
// rather than caching a row of nulls that would blank the tiles.

test('parseHelperTemps: a full reading is taken as-is, rounded the way the tiles render it', () => {
  const s = dc.parseHelperTemps('{"cpuTemp":45.2381,"gpuTemp":41.06,"gpu":23.7,"vramUsed":1234567890}');
  assert.deepEqual(s, { cpuTemp: 45.2, gpuTemp: 41.1, gpu: 24, vramUsed: 1234567890 });
});

test('parseHelperTemps: a reading with nothing in it returns null, so macmon still gets a turn', () => {
  // An Intel Mac exposes neither sensor family under these names and the
  // accelerator may publish no utilisation key: the helper answers, honestly,
  // with nothing. Caching that would leave the tiles blank on a machine that
  // has macmon installed and working.
  assert.equal(dc.parseHelperTemps('{"cpuTemp":null,"gpuTemp":null,"gpu":null,"vramUsed":null}'), null);
  assert.equal(dc.parseHelperTemps('{}'), null);
});

test('parseHelperTemps: a partial reading is kept — one real number is worth reporting', () => {
  assert.deepEqual(dc.parseHelperTemps('{"gpu":12,"cpuTemp":null,"gpuTemp":null}'),
    { cpuTemp: null, gpuTemp: null, gpu: 12, vramUsed: null });
});

test('parseHelperTemps: impossible values are dropped, not clamped into a plausible lie', () => {
  // 0 is what a present-but-not-reporting sensor answers, and the widget must
  // not show a CPU at 0 °C as if it were a reading.
  const s = dc.parseHelperTemps('{"cpuTemp":0,"gpuTemp":900,"gpu":140,"vramUsed":-5}');
  assert.equal(s.cpuTemp, null);
  assert.equal(s.gpuTemp, null);
  assert.equal(s.gpu, 100, 'a percentage is clamped, since 140% is a unit error not a bad sensor');
  assert.equal(s.vramUsed, null);
});

test('parseHelperTemps: garbage never throws', () => {
  for (const raw of ['', 'not json', 'null', '[]', '{"cpuTemp":"hot"}', undefined]) {
    assert.equal(dc.parseHelperTemps(raw), null, String(raw));
  }
});

// The app switcher's helper path. Same JSON the Windows helper answers, so the
// parser's job is only to hold the wire contract server.js enforces (the id
// shape, the protected filter, the cap) against a payload that crossed a
// process line.

test('parseHelperWindows: a well-formed list keeps the shape the /windows contract promises', () => {
  const raw = JSON.stringify({ windows: [
    { id: '1302', title: 'Anteprima', app: 'Anteprima', path: '/System/Applications/Preview.app', active: false, minimized: false, icon: null },
    { id: 88204, title: '', app: 'Code', path: '/Applications/Code.app', active: true, minimized: true, icon: null },
  ] });
  assert.deepEqual(dc.parseHelperWindows(raw, false), [
    { id: '1302', title: 'Anteprima', app: 'Anteprima', path: '/System/Applications/Preview.app', active: false, minimized: false, icon: null },
    // A numeric id is stringified, and an app with no window title falls back
    // to its own name rather than rendering an empty row.
    { id: '88204', title: 'Code', app: 'Code', path: '/Applications/Code.app', active: true, minimized: true, icon: null },
  ]);
});

test('parseHelperWindows: the protected filter and the id shape are re-applied host-side', () => {
  // The helper filters these itself. Re-checking here is the boundary rule: a
  // payload that crossed a process line is validated where it is consumed, so
  // an older or swapped binary cannot widen what the list may contain.
  const raw = JSON.stringify({ windows: [
    { id: '1', app: 'Finder' },
    { id: 'not-a-pid', app: 'Safari' },
    { id: '4', app: '' },
    { id: '5', app: 'Safari' },
  ] });
  assert.deepEqual(dc.parseHelperWindows(raw, false).map((w) => w.app), ['Safari']);
  // includeProtected is the close path: it has to see Finder to answer
  // "protected" instead of "not_found".
  assert.deepEqual(dc.parseHelperWindows(raw, true).map((w) => w.app), ['Finder', 'Safari']);
});

test('parseHelperWindows: the list is capped the way the osascript path is', () => {
  const many = { windows: Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1), app: `App${i}` })) };
  assert.equal(dc.parseHelperWindows(JSON.stringify(many), false).length, 24);
});

test('parseHelperWindows: garbage returns null, so the osascript path still gets a turn', () => {
  // null (not []) is what makes listApps fall through. An empty ARRAY is a
  // legitimate answer — a Mac with nothing open — and must not be confused
  // with a payload we could not read.
  for (const raw of ['', 'not json', 'null', '[]', '{}', '{"windows":"nope"}', undefined]) {
    assert.equal(dc.parseHelperWindows(raw, false), null, String(raw));
  }
  assert.deepEqual(dc.parseHelperWindows('{"windows":[]}', false), []);
});
