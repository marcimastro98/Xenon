'use strict';
// macOS disks in the shapes the Windows readers give: the volumes df and mount list, and each
// disk's reads and writes from ioreg.

const { run, runSoft, splitLines } = require('./darwin-read.js');

// --- Disks: df + mount, matching getAllDisksInfo()'s drive object shape ------
// Only `/` and real volumes under /Volumes are surfaced. Everything under
// /System/Volumes is an APFS role volume (Preboot, VM, Update, the Data volume
// itself) that shares one container with `/`, so listing them would show the
// same disk four times with four different "used" numbers.
//
// Used is computed as total - free rather than read from df's Used column. On an
// APFS volume group the `/` row reports only the sealed system volume as used
// (about 10 GB) while its Available reflects the whole shared container, so the
// Used column would tell the user a 900 GB disk is 1% full.
function skipVolume(target) {
  if (target === '/') return false;
  if (!target.startsWith('/Volumes/')) return true;
  const name = target.slice('/Volumes/'.length);
  return /^(Recovery|Preboot|Update|xarts|iSCPreboot|Hardware)$/i.test(name) ||
         name.startsWith('com.apple.TimeMachine') ||
         name.startsWith('.timemachine');
}

// `mount` prints: /dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)
function parseMountTypes(out) {
  const types = new Map();
  for (const line of splitLines(out)) {
    const m = line.match(/^(\S+)\s+on\s+(.+?)\s+\(([^,)]+)/);
    if (m) types.set(m[2], m[3].trim());
  }
  return types;
}

// `df -k -P -l` prints 1024-byte blocks with the mount point last.
function parseDisks(out, mountTypes) {
  const types = mountTypes instanceof Map ? mountTypes : new Map();
  const drives = [];
  const seen = new Set();
  for (const line of splitLines(String(out || '').trim()).slice(1)) {
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.*)$/);
    if (!m) continue;
    const target = m[6].trim();
    if (!target || skipVolume(target)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    // df -k reports 1024-byte blocks; the rest of Xenon speaks bytes.
    const total = Number(m[2]) * 1024;
    const free = Number(m[4]) * 1024;
    if (!(total > 0)) continue;
    const used = Math.max(0, total - free);
    drives.push({
      drive: target,
      total,
      used,
      free,
      percent: Math.round((used / total) * 100),
      label: target === '/' ? 'System' : target.split('/').filter(Boolean).pop() || '',
      fileSystem: types.get(target) || '',
      driveType: target === '/' ? 'Fixed' : 'Removable',
    });
  }
  return drives;
}

async function disks() {
  try {
    // -l keeps this to local filesystems: a stale network mount can wedge df.
    const [dfOut, mountOut] = await Promise.all([
      run('df', ['-k', '-P', '-l'], 5000),
      runSoft('mount', [], 5000),
    ]);
    const drives = parseDisks(dfOut, parseMountTypes(mountOut || ''));
    return drives.length ? drives : null;
  } catch {
    return null;
  }
}

// --- Per-disk I/O: ioreg ----------------------------------------------------
// Asked for on Discord for an SDK monitoring widget. `iostat` is the obvious
// tool and the wrong one here: on macOS it reports COMBINED transfers per disk,
// with no read/write split, which is half of what was asked for. The IOKit
// registry has both, as cumulative counters on each IOBlockStorageDriver:
//
//   +-o AppleAPFSMedia ...
//     "Statistics" = {"Bytes (Read)"=123,"Operations (Read)"=4,
//                     "Bytes (Write)"=567,"Operations (Write)"=8, ...}
//     "BSD Name" = "disk0"
//
// server.js turns the counters into rates with the same inter-poll delta it
// uses for the network ones.
//
// Pure, so the shape can be checked without a Mac. Everything is optional: a
// registry that prints something else yields no disks rather than wrong ones.
function parseIoregDisks(out) {
  const text = String(out || '');
  const disks = [];
  // Split on the object headers ioreg prints ("+-o Name <class …>") and parse
  // each one alone. A fixed window around the Statistics block is not enough:
  // the identity fields of the PREVIOUS disk are inside it, and every row after
  // the first came back wearing the first disk's name.
  const chunks = text.split(/^\s*\+-o /m);
  for (const chunk of chunks) {
    const stats = /"Statistics"\s*=\s*\{([^}]*)\}/.exec(chunk);
    if (!stats) continue;
    const num = (key) => {
      const g = new RegExp('"' + key.replace(/[().*+?^$|[\]{}\\]/g, '\\$&') + '"\\s*=\\s*(\\d+)').exec(stats[1]);
      return g ? Number(g[1]) : null;
    };
    const pick = (key) => {
      const g = new RegExp('"' + key + '"\\s*=\\s*"([^"]*)"').exec(chunk);
      return g ? g[1] : '';
    };
    const readBytes = num('Bytes (Read)');
    const writeBytes = num('Bytes (Write)');
    const id = pick('BSD Name');
    if (!id || (readBytes === null && writeBytes === null)) continue;
    disks.push({
      id,
      model: (pick('Product Name') || pick('Model')).trim() || id,
      serial: (pick('Serial Number') || '').trim(),
      readsCompleted: num('Operations (Read)') || 0,
      writesCompleted: num('Operations (Write)') || 0,
      readBytes: readBytes || 0,
      writeBytes: writeBytes || 0,
    });
  }
  // One entry per BSD name: a storage stack can present the same disk twice.
  const seen = new Set();
  return disks.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}

async function diskIo() {
  const out = await runSoft('ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-w0'], 5000);
  if (out === null) return [];
  const found = parseIoregDisks(out);
  if (!found.length) return [];
  // Which volumes sit on each disk, from the mount table the space collector
  // already reads. `df` prints /dev/disk3s1s1 — the disk is the leading
  // `diskN`.
  let mounts = [];
  try {
    const df = await run('df', ['-k', '-P', '-l'], 5000);
    mounts = splitLines(df).slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 6)
      .map((f) => ({ dev: f[0], mount: f.slice(5).join(' ') }))
      .filter((r) => r.dev.startsWith('/dev/'));
  } catch { /* no mount info: the rows simply carry none */ }
  for (const d of found) {
    d.volumes = mounts
      .filter((r) => new RegExp('^/dev/' + d.id + '(s\\d|$)').test(r.dev))
      .map((r) => ({ mount: r.mount, label: '', fstype: '' }));
    // No temperature on this platform: SMART is not exposed to an unprivileged
    // process, and inventing a number is worse than saying there isn't one.
    d.temperature = null;
    d.sizeBytes = null;
    d.kind = '';
  }
  return found;
}

module.exports = { skipVolume, parseMountTypes, parseDisks, disks, parseIoregDisks, diskIo };
