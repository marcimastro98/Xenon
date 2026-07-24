'use strict';
// darwin-collectors.js parsing — the pure functions behind the macOS collectors.
// These lock the same contracts the Windows collectors define, the way the
// Linux suite does: df's drive shape, cumulative interface counters, and the
// SoundVolumeView column layout the whole audio path is written against.
//
// The fixtures are written to each tool's documented output format rather than
// captured from a machine (this repo is developed on Windows). Re-capture them
// on a real Mac when one is available — the commands are, in order:
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
});

test('parseMacmon: garbage and partial lines degrade to nulls', () => {
  assert.deepEqual(dc.parseMacmon(''), { cpuTemp: null, gpu: null, gpuTemp: null });
  assert.deepEqual(dc.parseMacmon('not json'), { cpuTemp: null, gpu: null, gpuTemp: null });
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
