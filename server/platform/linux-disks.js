'use strict';
// Linux disks in the shapes the Windows readers give: the drives df lists, and each disk's
// reads, writes and temperature from /proc/diskstats and sysfs.

const fsp = require('node:fs').promises;
const { run, splitLines, readText } = require('./linux-read.js');

// --- Disks: df, matching getAllDisksInfo()'s drive object shape --------------
// Real filesystems only: skip pseudo/virtual mounts (tmpfs, overlay, snap loops,
// docker). /boot/efi is kept as it is a genuine volume. Bytes throughout.
const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'sysfs', 'proc', 'cgroup', 'cgroup2', 'overlay', 'squashfs',
  'efivarfs', 'devpts', 'mqueue', 'hugetlbfs', 'debugfs', 'tracefs', 'fusectl',
  'configfs', 'securityfs', 'pstore', 'bpf', 'autofs', 'binfmt_misc', 'ramfs',
  'nsfs', 'fuse.portal', 'fuse.gvfsd-fuse',
]);
// Prefixes are matched WITH their separator (or as the whole mount point), so a
// real volume at /devdata, /mntbackup or /system-backup is not mistaken for the
// pseudo-tree it happens to share a few letters with.
const SKIP_PREFIXES = ['/snap', '/var/lib/docker', '/proc', '/sys', '/dev', '/run'];
function skipMount(target) {
  const t = String(target || '');
  // The one real exception under /run: udisks2 auto-mounts every USB stick, SD
  // card and external drive at /run/media/<user>/<label> on Fedora, RHEL, Arch,
  // Manjaro and openSUSE. Skipping the whole of /run hid removable media on all
  // of them (Ubuntu and Debian escaped only because they use /media/<user>/…),
  // and left the `removable` test below unreachable.
  if (t.startsWith('/run/media/')) return false;
  return SKIP_PREFIXES.some((p) => t === p || t.startsWith(p + '/'));
}
// Split out so the parsing is unit-testable against a captured `df` fixture.
function parseDisks(out) {
  const lines = splitLines(String(out || '').trim()).slice(1); // drop header
  const seen = new Set();
  const drives = [];
  for (const line of lines) {
    const c = line.trim().split(/\s+/);
    if (c.length < 6) continue;
    // Parse from BOTH ends, never by fixed index. `df` prints the mount point
    // with its literal spaces, so a drive at /media/alex/My Passport shifted
    // every column after it: Number(c[3]) was NaN and `!(total > 0)` discarded
    // the row without a word. Source is first, the size/used/avail trio and the
    // fstype are last, and whatever sits between them IS the mount point. (A
    // source with spaces — a CIFS share — stays unparseable either way; it now
    // fails the absolute-path test below instead of failing as a NaN.)
    const source = c[0];
    const fstype = c[c.length - 4];
    const target = c.slice(1, c.length - 4).join(' ');
    const total = Number(c[c.length - 3]);
    const free = Number(c[c.length - 1]);
    if (!target.startsWith('/')) continue;
    if (!Number.isFinite(total) || !Number.isFinite(free)) continue;
    // Used is computed as total - free, never df's own Used column — the same
    // rule darwin-collectors.js follows, and the contract doctor-checks.mjs
    // enforces. On ext4 the two disagree: mke2fs reserves 5% of the filesystem
    // for root, df counts those blocks in neither Used nor Available, and the
    // tile then draws a bar whose segments do not add up to the disk. Measured
    // on /boot (1.9 GB, 1.8 GB accounted for) the gap was 6% — small in
    // absolute terms, large enough that the label and the bar disagreed.
    // Counting reserved space as used is also the honest reading: it is space
    // this user cannot write to, and `free` stays the number that says what
    // will actually fit.
    const used = Math.max(0, total - free);
    if (PSEUDO_FS.has(fstype) || fstype.startsWith('fuse.')) continue;
    if (skipMount(target)) continue;
    if (!(total > 0)) continue;
    // Key on the pair, not the device. A btrfs (or LVM-thin, or ZFS) layout
    // mounts several subvolumes from ONE source, so deduping on source alone
    // silently drops every mount after the first: on the common
    // /-plus-/home-on-one-device setup, /home disappeared entirely. The pair
    // still collapses a genuinely repeated row. Note that sibling subvolumes
    // share one pool, so their capacities are the same filesystem counted once
    // per mount, not independent space.
    const key = source + '\0' + target;
    if (seen.has(key)) continue;
    seen.add(key);
    // Same separator rule as skipMount: /mediaserver is not removable media.
    const removable = ['/media', '/mnt', '/run/media']
      .some((p) => target === p || target.startsWith(p + '/'));
    drives.push({
      drive: target,
      total,
      used,
      free,
      percent: Math.round((used / total) * 100),
      label: target === '/' ? 'System' : target.split('/').filter(Boolean).pop() || '',
      fileSystem: fstype,
      driveType: removable ? 'Removable' : 'Fixed',
    });
  }
  return drives;
}
async function disks() {
  try {
    const out = await run('df', ['-B1', '--output=source,target,fstype,size,used,avail'], 5000);
    const drives = parseDisks(out);
    return drives.length ? drives : null;
  } catch {
    return null;
  }
}

// --- Per-disk I/O: /proc/diskstats + sysfs ----------------------------------
// Asked for on Discord by someone building a workstation monitor on the SDK:
// throughput and IOPS per physical disk, with a stable id, the model, and the
// volume/mount so a person can tell which disk is which.
//
// /proc/diskstats is cumulative since boot, so server.js does the same
// inter-poll delta it does for network counters. The sector size is 512 bytes
// by convention in this file REGARDLESS of the device's real logical block
// size — that is the kernel's documented unit here, and reading
// queue/hw_sector_size to "correct" it is the classic way to get 4Kn drives
// wrong by 8x.
//
// Fields (Documentation/admin-guide/iostats.rst), 1-indexed after major/minor/name:
//   1 reads completed   3 sectors read   5 writes completed   7 sectors written
const DISK_VIRTUAL = /^(loop|ram|zram|dm-|md|sr|fd|nbd|zd)/;
function parseDiskstats(text) {
  const out = [];
  for (const line of splitLines(text)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[2];
    if (!name || DISK_VIRTUAL.test(name)) continue;
    out.push({
      id: name,
      readsCompleted: Number(f[3]) || 0,
      sectorsRead: Number(f[5]) || 0,
      writesCompleted: Number(f[7]) || 0,
      sectorsWritten: Number(f[9]) || 0,
    });
  }
  return out;
}

// A partition (sda1, nvme0n1p2) is not a disk: its counters are already inside
// its parent's, so listing both would double every number on screen. sysfs
// answers this exactly — a whole disk has a `device` link, a partition has a
// `partition` file — with a name-shape fallback for the rare device that has
// neither.
const PART_SHAPE = /^(?:(?:sd|hd|vd|xvd)[a-z]+\d+|nvme\d+n\d+p\d+|mmcblk\d+p\d+)$/;
async function isWholeDisk(name) {
  try {
    await fsp.access(`/sys/block/${name}`);
    return true;                      // only whole disks appear in /sys/block
  } catch {
    return !PART_SHAPE.test(name);
  }
}

// Which mounted filesystems live on this disk, so a row can say "Samsung 990 —
// / and /home" rather than "nvme0n1". Partitions are matched by name prefix,
// which is how the kernel names them.
function parseMountsFor(mountsText) {
  const rows = [];
  for (const line of splitLines(mountsText)) {
    const f = line.split(/\s+/);
    if (f.length < 3) continue;
    const dev = f[0];
    if (!dev.startsWith('/dev/')) continue;
    rows.push({ dev: dev.slice(5), mount: f[1].replace(/\\040/g, ' '), fstype: f[2] });
  }
  return rows;
}

async function diskIo() {
  let stats;
  try { stats = parseDiskstats(await fsp.readFile('/proc/diskstats', 'utf8')); }
  catch { return []; }

  let mounts = [];
  try { mounts = parseMountsFor(await fsp.readFile('/proc/mounts', 'utf8')); } catch { /* none */ }

  // Disk temperature is free here when the kernel publishes it: the drivetemp
  // module for SATA, nvme's own hwmon for NVMe. No SMART poll of our own, so
  // nothing here can wake a spun-down disk.
  const temps = await readDriveTemps();

  const out = [];
  for (const st of stats) {
    if (!(await isWholeDisk(st.id))) continue;
    const base = `/sys/block/${st.id}`;
    const readOr = async (rel, fallback = '') => { try { return await readText(`${base}/${rel}`); } catch { return fallback; } };
    const model = (await readOr('device/model')).trim();
    const sizeSectors = Number(await readOr('size', '0')) || 0;
    const rotational = (await readOr('queue/rotational')) === '1';
    const vols = mounts
      .filter((m) => m.dev === st.id || m.dev.startsWith(st.id))
      .map((m) => ({ mount: m.mount, label: '', fstype: m.fstype }));
    out.push({
      ...st,
      // `id` is the kernel name and it is what sysfs is keyed on. It is stable
      // for a fixed set of disks but NOT across a re-plug on some controllers,
      // which is why the serial rides along for anyone who wants to be sure.
      serial: (await readOr('device/serial')).trim() || (await readOr('device/wwid')).trim(),
      model: model || st.id,
      sizeBytes: sizeSectors * 512,
      kind: rotational ? 'hdd' : 'ssd',
      volumes: vols,
      temperature: temps[st.id] ?? null,
    });
  }
  return out;
}

// hwmon entries whose device link points back at a block device. Best-effort by
// design: most desktops have nothing here unless `drivetemp` is loaded.
async function readDriveTemps() {
  const out = Object.create(null);
  let dirs = [];
  try { dirs = await fsp.readdir('/sys/class/hwmon'); } catch { return out; }
  await Promise.all(dirs.map(async (d) => {
    const base = `/sys/class/hwmon/${d}`;
    try {
      // …/hwmon/hwmonN/device/block/<name> for drivetemp; nvme exposes the
      // controller, whose block devices are one level down.
      let names = [];
      try { names = await fsp.readdir(`${base}/device/block`); } catch { /* not a disk */ }
      if (!names.length) return;
      const milli = Number(await readText(`${base}/temp1_input`));
      if (!Number.isFinite(milli)) return;
      for (const n of names) out[n] = Math.round((milli / 1000) * 10) / 10;
    } catch { /* unreadable chip */ }
  }));
  return out;
}

module.exports = {
  PSEUDO_FS, SKIP_PREFIXES, skipMount, parseDisks, disks, DISK_VIRTUAL, parseDiskstats, PART_SHAPE,
  isWholeDisk, parseMountsFor, diskIo, readDriveTemps,
};
