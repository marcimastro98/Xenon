// linux-collectors.js - Linux data sources for Xenon's Windows-only collectors.
//
// Xenon is Windows-first: its GPU / disk / CPU-temperature / network collectors
// shell out to PowerShell and WMI (gpu.ps1, network.ps1, Get-CimInstance ...),
// the app switcher drives a Win32 EnumWindows helper, and the volume mixer
// drives SoundVolumeView.exe. None of those exist on Linux, so the system tiles
// render "--", the app switcher reports "No open windows found", and the mixer
// reports "audio unavailable".
//
// This module provides native Linux equivalents (nvidia-smi, df,
// /sys/class/hwmon, /proc/net/dev, ping, wmctrl/xdotool/xprop, PipeWire) that
// return the SAME shapes the Windows collectors produced, so the existing
// caching, merge, bandwidth-delta and CSV-column logic in server.js is
// untouched. server.js only calls in when process.platform === 'linux'; the
// Windows code paths are unchanged.
//
// Everything here is async: these run on the SSE sensor path, so there is no
// synchronous filesystem access anywhere in this file.
//
// Requirements on Linux (each degrades to the previous "--" behaviour if the
// tool is absent): nvidia-smi for an NVIDIA GPU (AMD and Intel need nothing —
// they are read from /sys/class/drm), wmctrl + xdotool + x11-utils for the app
// switcher (X11 sessions), pipewire + wireplumber (pw-dump, wpctl) for audio,
// playerctl for now-playing (see linux-media.js).

'use strict';

const { execFile } = require('child_process');
const fsp = require('fs').promises;
const os = require('os');
// Shared with darwin-collectors.js: the delta/aggregation half of the
// `processes` stream is identical on both, and lives in one tested place.
const procStats = require('./process-stats');

// --- Memory: /proc/meminfo, because os.freemem() means something else here ---
// os.freemem() is MemFree, which excludes the page cache the kernel would hand
// straight back — so `total - free` counts every cached file as used and the
// RAM tile reads far higher than anything the user's own tools show. On Windows
// the same call is ullAvailPhys and already accounts for that, which is why the
// figure was right there and wrong the moment the port reached a second OS.
// MemAvailable is the kernel's own answer to "how much could a new workload
// get", which is exactly the Windows meaning, and it has been in /proc/meminfo
// since 3.14. Where it is missing the classic approximation stands in.
function parseMemInfo(out) {
  const kb = (label) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\s*kB`, 'm').exec(String(out || ''));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  if (!total) return null;
  let available = kb('MemAvailable');
  if (available === null) {
    const free = kb('MemFree'), buffers = kb('Buffers'), cached = kb('Cached');
    if (free === null) return null;
    available = free + (buffers || 0) + (cached || 0);
  }
  return { used: Math.max(0, Math.min(total, total - available)), total };
}

async function memory() {
  let raw = null;
  try { raw = await fsp.readFile('/proc/meminfo', 'utf8'); } catch { /* not procfs */ }
  const parsed = raw === null ? null : parseMemInfo(raw);
  return parsed || { used: os.totalmem() - os.freemem(), total: os.totalmem() };
}

// Promise wrapper around execFile with a hard timeout; resolves stdout.
function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

const isNum = (s) => /^-?\d+(\.\d+)?$/.test(String(s).trim());

// Split on LF or CRLF. Worth being explicit about why: `\r` counts as a line
// terminator in JS regex, so `.` does not match it, and a pattern anchored with
// `$` fails on a CRLF line entirely instead of merely capturing a trailing
// character. These parsers read tool output on Linux, but the fixtures behind
// them are files that a Windows checkout can convert, so the parsers accept both.
const splitLines = (text) => String(text || '').split(/\r?\n/);

// Run an async mapper over items with at most `limit` in flight. Promise.all on
// a whole window list forks that many processes at once; a desktop with many
// windows would spike to one xprop per window in a single tick.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// --- GPU: nvidia-smi, matching gpu.ps1's field order and byte units ----------
// gpu.ps1 queried: utilization.gpu,temperature.gpu,memory.used,memory.total,name
// and converted MiB -> bytes (value * 1048576). We reproduce that exactly.
// nvidia-smi is the NVIDIA path only; AMD and Intel are read straight from the
// kernel's DRM sysfs by parseSysfsGpu below, which needs no tool at all.
const EMPTY_GPU = { gpu: null, gpuTemp: null, gpuName: null, vramUsed: null, vramTotal: null };
function parseGpu(out) {
  const first = splitLines(String(out || '').trim())[0] || '';
  const p = first.split(',').map((s) => s.trim());
  if (p.length < 5) return { ...EMPTY_GPU };
  return {
    gpu: isNum(p[0]) ? Math.round(Number(p[0])) : null,
    gpuTemp: isNum(p[1]) ? Math.round(Number(p[1])) : null,
    vramUsed: isNum(p[2]) ? Math.round(Number(p[2])) * 1048576 : null,
    vramTotal: isNum(p[3]) ? Math.round(Number(p[3])) * 1048576 : null,
    gpuName: p.slice(4).join(', ').trim() || null,
  };
}
// --- GPU without nvidia-smi: the kernel's own DRM sysfs -----------------------
// AMD (amdgpu) publishes load, VRAM and temperature as plain files, so a machine
// with a Radeon needs no extra tool at all. Intel publishes far less: `i915`/
// `xe` expose a temperature on recent kernels and nothing else a shell can read
// (utilisation needs perf counters or intel_gpu_top as root), and an integrated
// GPU has no separate VRAM — 0 is the honest answer there, not a missing one.
//
// Pure so it can be tested off Linux: the caller reads the files, this decides
// what they mean.
const GPU_DRIVER_NAMES = { amdgpu: 'AMD GPU', radeon: 'AMD GPU', i915: 'Intel GPU', xe: 'Intel GPU' };

// --- Intel activity from RC6 residency ---------------------------------------
// Intel publishes no `gpu_busy_percent`, and the utilisation the PMU can give
// needs perf permissions this backend deliberately does not have: it runs as the
// user, with no capabilities, and `perf_event_paranoid` is 2 on a stock Fedora.
// So the tile showed "--%" on every Intel machine, which is most laptops.
//
// `power/rc6_residency_ms` is readable by anyone and counts the milliseconds the
// render engine spent in its deepest sleep state. The complement of its rate is
// the share of wall-clock time the GPU was awake. That is NOT execution-unit
// utilisation — an awake-but-lightly-loaded GPU counts as busy — so it reads
// higher than nvidia-smi would for the same work. It is a real, responsive
// measurement of the same underlying thing, and it moves: measured on this
// port, idle desktop 10-11%, dashboard rendering 14-16%, first paint ~69%.
//
// Pure, given two samples, so the arithmetic is testable without a GPU.
function rc6Busy(prev, cur) {
  if (!prev || !cur) return null;
  const dRc6 = cur.rc6Ms - prev.rc6Ms;
  const dWall = cur.atMs - prev.atMs;
  // A counter that went backwards means the driver reloaded or the machine
  // suspended; a window that is too short cannot be divided meaningfully, and
  // one that is too long spans a sleep during which neither clock was running.
  if (!(dWall >= 500 && dWall <= 300000)) return null;
  if (!(dRc6 >= 0)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - (dRc6 * 100) / dWall)));
}

function parseSysfsGpu(snap) {
  const s = snap || {};
  const num = (v) => (isNum(v) ? Number(String(v).trim()) : null);
  const busy = num(s.busy);
  const used = num(s.vramUsed);
  const total = num(s.vramTotal);
  // hwmon reports millidegrees. A card that lists several sensors labels them
  // (edge / junction / mem on AMD); `edge` is the one comparable to what every
  // other platform calls the GPU temperature, so it wins when present.
  let tempMilli = null;
  for (const t of Array.isArray(s.temps) ? s.temps : []) {
    if (!t || !isNum(t.value)) continue;
    const label = String(t.label || '').trim().toLowerCase();
    if (tempMilli === null || label === 'edge') tempMilli = Number(t.value);
    if (label === 'edge') break;
  }
  return {
    gpu: busy === null ? null : Math.max(0, Math.min(100, Math.round(busy))),
    // Millidegrees only above a plausible ceiling: some drivers already report
    // degrees, and dividing those by 1000 would silently report 0.
    gpuTemp: tempMilli === null ? null : Math.round(tempMilli > 200 ? tempMilli / 1000 : tempMilli),
    vramUsed: used === null ? null : used,
    vramTotal: total === null ? null : total,
    gpuName: GPU_DRIVER_NAMES[String(s.driver || '').trim()] || null,
  };
}

const SYSFS_DRM = '/sys/class/drm';

async function readOrNull(file) {
  try { return String(await fsp.readFile(file, 'utf8')).trim(); } catch { return null; }
}

// Read one card's files into the snapshot parseSysfsGpu expects.
async function readCardSnapshot(dir) {
  const uevent = await readOrNull(`${dir}/device/uevent`);
  const driver = uevent ? (/^DRIVER=(.+)$/m.exec(uevent) || [])[1] : null;
  const temps = [];
  try {
    const hwmonRoot = `${dir}/device/hwmon`;
    for (const h of await fsp.readdir(hwmonRoot)) {
      for (let i = 1; i <= 3; i++) {
        const value = await readOrNull(`${hwmonRoot}/${h}/temp${i}_input`);
        if (value === null) continue;
        temps.push({ value, label: await readOrNull(`${hwmonRoot}/${h}/temp${i}_label`) });
      }
    }
  } catch { /* no hwmon for this card */ }
  return {
    driver: driver ? driver.trim() : null,
    busy: await readOrNull(`${dir}/device/gpu_busy_percent`),
    vramUsed: await readOrNull(`${dir}/device/mem_info_vram_used`),
    vramTotal: await readOrNull(`${dir}/device/mem_info_vram_total`),
    // Only meaningful while RC6 is actually enabled. With it off the counter
    // never advances, and a rate computed from a frozen counter reads as a
    // permanently pegged 100% — the one wrong answer worse than no answer.
    rc6Enabled: (await readOrNull(`${dir}/power/rc6_enable`)) === '1',
    rc6Ms: Number(await readOrNull(`${dir}/power/rc6_residency_ms`)),
    temps,
  };
}

// Last RC6 sample per card, so the next poll can turn two readings into a rate.
// server.js polls this collector on its own timer; the first call after a boot
// therefore has nothing to compare against and reports null, exactly as it did
// before — one poll of "--", then numbers.
const _rc6Last = new Map();

// The interesting card on a hybrid laptop is the discrete one, and sysfs has
// no "integrated" flag — but the discrete card is the one that answers with
// MORE: a load figure, a temperature and a dedicated-VRAM size. So candidates
// compete on completeness, with the bigger VRAM as the tie-break (a dGPU's
// dedicated memory dwarfs an APU's carve-out). The previous rule — first card
// with any non-null load wins — locked in the iGPU, because an idle iGPU's
// busy reading is 0, which is non-null, and the discrete card was then read
// and thrown away on every poll. Pure and exported so the selection is
// testable off-platform, where sysfs itself cannot be.
function betterGpuCandidate(best, next) {
  if (!best) return next;
  if (!next) return best;
  const score = (p) => (p.gpu !== null ? 2 : 0) + (p.gpuTemp !== null ? 1 : 0) + (p.vramTotal !== null ? 1 : 0);
  const a = score(best);
  const b = score(next);
  if (b > a) return next;
  if (b === a && (next.vramTotal || 0) > (best.vramTotal || 0)) return next;
  return best;
}

async function sysfsGpu() {
  let cards;
  try {
    // cardN only: the cardN-HDMI-A-1 entries are connectors, not devices.
    cards = (await fsp.readdir(SYSFS_DRM)).filter((n) => /^card\d+$/.test(n)).sort();
  } catch { return null; }
  let best = null;
  for (const name of cards) {
    const snap = await readCardSnapshot(`${SYSFS_DRM}/${name}`);
    if (!snap.driver) continue;
    const parsed = parseSysfsGpu(snap);
    // amdgpu answers `gpu_busy_percent` directly and needs none of this. Intel
    // has no such file, so the load comes from how much of the interval since
    // the last poll the GPU spent out of RC6.
    if (parsed.gpu === null && snap.rc6Enabled && Number.isFinite(snap.rc6Ms)) {
      const cur = { rc6Ms: snap.rc6Ms, atMs: Date.now() };
      parsed.gpu = rc6Busy(_rc6Last.get(name), cur);
      _rc6Last.set(name, cur);
    }
    // Every card is read: there are at most a handful, and an early break on
    // "good enough" is what used to hide the discrete card behind the iGPU.
    best = betterGpuCandidate(best, parsed);
  }
  return best;
}

async function gpu() {
  try {
    return parseGpu(await run('nvidia-smi',
      ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name',
       '--format=csv,noheader,nounits'], 5000));
  } catch {
    // No NVIDIA driver (or no nvidia-smi): fall through to the kernel's own
    // files, which is the whole AMD story and half of the Intel one.
    try {
      const fromSysfs = await sysfsGpu();
      if (fromSysfs) return fromSysfs;
    } catch { /* fall through to empty */ }
    return { ...EMPTY_GPU };
  }
}

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
    // with its literal spaces, so a drive at /media/marci/My Passport shifted
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

// --- CPU temperature and fans: /sys/class/hwmon ------------------------------
// Returns { cpuTemp: number|null, fans: [{name, rpm, kind}] } to match the shape
// CPU_TEMP_SCRIPT produces on Windows.
//
// Fans need no LibreHardwareMonitor and no elevation here: any chip with a
// tachometer publishes `fanN_input` in RPM as a world-readable file. That is the
// whole feature on this platform, which is why the widget's "install the
// companion / re-run INSTALL.bat" hint was doubly wrong on Linux — it named a
// Windows dependency and a Windows installer for something the kernel already
// had. Coverage is per-driver: laptops with `thinkpad`/`dell_smm`/`applesmc`
// report, most desktops report through `nct6775` and friends once lm_sensors has
// loaded the right module, and a machine whose chip has no driver reports
// nothing — which is then genuinely nothing, not a missing tool.
const readText = async (p) => (await fsp.readFile(p, 'utf8')).trim();

// Pure: given [{chip, index, rpm, label}] decide what the tile shows. Kept
// separate so the naming and filtering rules are testable without hwmon.
function parseHwmonFans(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    // `isNum` first, not `Number()`: an unreadable sysfs file yields an empty
    // string, and Number('') is 0 — which would have published a phantom fan,
    // stopped, for every empty tachometer on the machine.
    if (!isNum(r.rpm)) continue;
    const rpm = Number(r.rpm);
    // 0 itself is real and kept: a card in zero-RPM mode has genuinely stopped
    // its fans, and the tile is meant to show that rather than hide the fan.
    if (rpm < 0 || rpm > 30000) continue;
    const label = String(r.label || '').trim();
    const chip = String(r.chip || '').trim();
    // The label when the driver gives one ("CPU Fan"), otherwise the chip plus
    // its index, which is what lm_sensors shows and what the user can rename.
    const name = label || (chip ? `${chip} fan ${r.index}` : `Fan ${r.index}`);
    out.push({ name: name.slice(0, 48), rpm: Math.round(rpm), kind: 'mb' });
  }
  return out;
}

async function readHwmonFans() {
  const rows = [];
  try {
    const base = '/sys/class/hwmon';
    for (const d of await fsp.readdir(base)) {
      const dir = `${base}/${d}`;
      let chip = '';
      try { chip = await readText(`${dir}/name`); } catch { /* unnamed chip */ }
      for (let i = 1; i <= 8; i++) {
        let rpm;
        try { rpm = await readText(`${dir}/fan${i}_input`); } catch { continue; }
        let label = '';
        try { label = await readText(`${dir}/fan${i}_label`); } catch { /* unlabelled */ }
        rows.push({ chip, index: i, rpm, label });
      }
    }
  } catch { /* no hwmon at all */ }
  return parseHwmonFans(rows);
}

async function cpuTemp() {
  const fans = await readHwmonFans();
  try {
    const base = '/sys/class/hwmon';
    for (const d of await fsp.readdir(base)) {
      const dir = `${base}/${d}`;
      let name = '';
      try { name = await readText(`${dir}/name`); } catch { continue; }
      if (name !== 'k10temp' && name !== 'coretemp') continue;
      for (let i = 1; i <= 8; i++) {
        let raw;
        try { raw = await readText(`${dir}/temp${i}_input`); } catch { continue; }
        let label = '';
        try { label = await readText(`${dir}/temp${i}_label`); } catch { /* unlabelled */ }
        if (/Tctl|Tdie|Tccd|Package|Core 0/i.test(label) || i === 1) {
          const milli = Number(raw);
          if (Number.isFinite(milli)) return { cpuTemp: Math.round((milli / 1000) * 10) / 10, fans };
        }
      }
    }
  } catch { /* no hwmon, or unreadable */ }
  return { cpuTemp: null, fans };
}

// --- Network: ping (1.1.1.1) + /proc/net/dev, matching network.ps1 shape -----
// Returns { ping, latency, rxBytes, txBytes, fps, gpuLatency }. server.js turns
// the rx/tx byte counters into down/up bandwidth via its own inter-poll delta.
// Physical NICs only: skip loopback, containers, bridges, tunnels, VPNs.
const VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|tun|tap|wg|vmnet|vboxnet|zt|ppp|bond|dummy)/;
function parseNetDev(text) {
  let rx = 0;
  let tx = 0;
  const lines = splitLines(text).slice(2);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const iface = line.slice(0, idx).trim();
    if (VIRTUAL_IFACE.test(iface)) continue;
    const f = line.slice(idx + 1).trim().split(/\s+/);
    if (f.length < 9) continue;
    rx += Number(f[0]) || 0;  // Receive bytes
    tx += Number(f[8]) || 0;  // Transmit bytes
  }
  return { rx, tx };
}
async function readNetBytes() {
  try {
    return parseNetDev(await fsp.readFile('/proc/net/dev', 'utf8'));
  } catch {
    return { rx: 0, tx: 0 };
  }
}
// ping's summary line gives min/avg/max/mdev; ping=avg, latency=jitter (max-min),
// the same two numbers network.ps1 derives from its three echoes.
function parsePing(out) {
  const m = String(out || '').match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
  if (!m) return { ping: null, latency: null };
  return { ping: Math.round(Number(m[2])), latency: Math.round(Number(m[3]) - Number(m[1])) };
}
async function pingStats() {
  try {
    return parsePing(await run('ping', ['-c', '3', '-W', '1', '-n', '1.1.1.1'], 5000));
  } catch {
    return { ping: null, latency: null };
  }
}
async function network() {
  const [{ ping, latency }, { rx, tx }] = await Promise.all([pingStats(), readNetBytes()]);
  return { ping, latency, rxBytes: rx, txBytes: tx, fps: null, gpuLatency: null };
}

// --- Open windows / app switcher: wmctrl + xdotool (X11) --------------------
// Xenon's /windows endpoint (list/focus/close) drives its "Open applications"
// widget through a Windows helper (windows.ps1, Win32 EnumWindows). We reproduce
// the same JSON contract the PowerShell path emits:
//   list  -> { windows: [ { id, title, app, path, active, minimized, icon } ] }
//   focus -> { ok }
//   close -> { ok, app, path }  (or { ok:false, error:'protected'|'not_found' })
// ids are DECIMAL strings (server.js validates /^\d{1,24}$/), matching the HWND
// contract; here they are the X11 window id in decimal.
//
// KNOWN LIMIT: X11 only. Wayland has no equivalent unprivileged window-listing
// protocol, so this returns an empty list under a Wayland session. (Under a
// Wayland session with Xwayland, the X11 clients running through it — which
// includes most games — are still listed; native Wayland windows are not.)
//
// LISTING needs nothing but xprop: _NET_CLIENT_LIST and a property read per
// window are the same data wmctrl prints, and asking the user to install
// wmctrl for a read-only list was a dependency the widget did not need. wmctrl
// and xdotool are still used to ACT on a window (focus, close), because that
// means sending a client message rather than reading a property, and neither
// is worth hand-rolling. So: the list appears with x11-utils alone, and the
// buttons that need more say so.
const MAX_WINDOWS = 24;
// At most this many xprop processes in flight at once.
const XPROP_CONCURRENCY = 8;

// Ensure X access even when the server was launched without a session env.
function xEnv() {
  const env = { ...process.env };
  if (!env.DISPLAY) env.DISPLAY = ':0';
  if (!env.XAUTHORITY) {
    try { env.XAUTHORITY = `/run/user/${process.getuid()}/gdm/Xauthority`; } catch { /* no getuid */ }
  }
  return env;
}
function runX(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env: xEnv(), windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

// WM_CLASS classes we never surface/close: the desktop shell itself.
const PROTECTED_CLASSES = new Set(['gnome-shell', 'Gnome-shell', 'xfdesktop', 'plasmashell']);

async function appFromExe(pid) {
  try {
    const exe = await fsp.readlink(`/proc/${pid}/exe`);
    return { path: exe, name: exe.split('/').filter(Boolean).pop() || '' };
  } catch {
    return { path: '', name: '' };
  }
}

// wmctrl -lp: "<id> <desktop> <pid> <host> <title...>". host is one token, so
// the first four fields are unambiguous and the remainder is the title.
function parseWmctrl(raw) {
  const rows = [];
  for (const line of splitLines(raw)) {
    const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const title = (m[5] || '').trim();
    if (!title) continue; // untitled utility/override-redirect windows
    rows.push({ hexId: m[1], pid: m[3], title, dec: parseInt(m[1], 16) });
  }
  return rows;
}

// WM_CLASS(STRING) = "instance", "Class" -> take the Class (2nd) string.
function parseWindowProps(out) {
  const minimized = !!(out && out.includes('_NET_WM_STATE_HIDDEN'));
  let cls = '';
  if (out) {
    const m = out.match(/WM_CLASS\(STRING\)\s*=\s*"(?:[^"]*)",\s*"([^"]*)"/) ||
              out.match(/WM_CLASS\(STRING\)\s*=\s*"([^"]*)"/);
    if (m) cls = m[1];
  }
  return { minimized, cls };
}
async function windowProps(hexId) {
  return parseWindowProps(await runX('xprop', ['-id', hexId, 'WM_CLASS', '_NET_WM_STATE'], 3000));
}

// `_NET_CLIENT_LIST(WINDOW): window id # 0x1, 0x2, …` — every managed window,
// which is the same set wmctrl -l prints because that is where wmctrl reads it.
function parseClientList(raw) {
  const m = String(raw || '').match(/window id # (.*)$/m);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]+$/.test(s));
}

// A window's title and owning pid, from the properties wmctrl would have read.
// _NET_WM_NAME (UTF-8) is preferred over WM_NAME (latin-1): a window titled
// with anything non-ASCII comes out mangled from the older property, which is
// most of them on a non-English desktop.
function parseWindowIdentity(raw) {
  const s = String(raw || '');
  const pidM = s.match(/_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/);
  const nameM = s.match(/_NET_WM_NAME\(UTF8_STRING\)\s*=\s*"((?:[^"\\]|\\.)*)"/) ||
                s.match(/WM_NAME\(STRING\)\s*=\s*"((?:[^"\\]|\\.)*)"/);
  const title = nameM ? nameM[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim() : '';
  return { pid: pidM ? pidM[1] : '', title };
}

// The window ids, titles and pids, without wmctrl. One xprop for the list, one
// per window — capped the same way the wmctrl path is.
async function listRowsViaXprop() {
  const ids = parseClientList(await runX('xprop', ['-root', '_NET_CLIENT_LIST'], 5000));
  if (!ids.length) return [];
  const infos = await mapLimit(ids.slice(0, MAX_WINDOWS * 2), XPROP_CONCURRENCY, (hexId) =>
    runX('xprop', ['-id', hexId, '_NET_WM_NAME', 'WM_NAME', '_NET_WM_PID'], 3000));
  const rows = [];
  ids.slice(0, MAX_WINDOWS * 2).forEach((hexId, i) => {
    const { pid, title } = parseWindowIdentity(infos[i]);
    // Untitled windows are utility/override-redirect surfaces, dropped here for
    // the same reason the wmctrl path drops them.
    if (!title) return;
    rows.push({ hexId, pid, title, dec: parseInt(hexId, 16) });
  });
  return rows;
}

async function listWindows() {
  const [raw, activeRaw] = await Promise.all([
    runX('wmctrl', ['-lp'], 5000),
    runX('xprop', ['-root', '_NET_ACTIVE_WINDOW'], 3000),
  ]);
  // wmctrl's one-shot listing when it is installed; otherwise the same data
  // assembled from xprop, so the widget works on a bare x11-utils machine.
  const rows = raw ? parseWmctrl(raw) : await listRowsViaXprop();
  if (!rows.length) return { windows: [] };
  const activeHex = (String(activeRaw || '').match(/window id # (0x[0-9a-fA-F]+)/) || [])[1];
  const activeDec = activeHex ? parseInt(activeHex, 16) : -1;

  // Resolve the executable first: /proc readlink is cheap and needs no process.
  // Sorting and capping on that name means we spawn xprop for at most
  // MAX_WINDOWS windows instead of one per window on the whole desktop.
  const withExe = await Promise.all(rows.map(async (r) => ({
    ...r, exe: await appFromExe(r.pid), active: r.dec === activeDec,
  })));
  withExe.sort((a, b) =>
    (b.active - a.active) ||
    a.exe.name.localeCompare(b.exe.name) ||
    a.title.localeCompare(b.title));
  const capped = withExe.slice(0, MAX_WINDOWS);

  const props = await mapLimit(capped, XPROP_CONCURRENCY, (r) => windowProps(r.hexId));
  const windows = [];
  capped.forEach((r, i) => {
    const p = props[i];
    if (PROTECTED_CLASSES.has(p.cls)) return; // hide the desktop shell
    windows.push({
      id: String(r.dec),
      title: r.title,
      app: p.cls || r.exe.name || 'App',
      path: r.exe.path,
      active: r.active,
      minimized: p.minimized,
      icon: null, // no icon extraction on Linux; the UI falls back to an initial
    });
  });

  // Re-sort on the final labels (WM_CLASS is nicer than the binary name), which
  // is the ordering the PowerShell path emits: active first, then app, then title.
  windows.sort((a, b) =>
    (b.active - a.active) ||
    a.app.localeCompare(b.app) ||
    a.title.localeCompare(b.title));
  return { windows };
}

// Raising a window means sending _NET_ACTIVE_WINDOW to the WM, which needs a
// real X client. Either tool can; wmctrl is tried second because xdotool takes
// the decimal id this API already carries.
async function focusWindow(decId) {
  if (await runX('xdotool', ['windowactivate', String(decId)], 5000) !== null) return { ok: true };
  const hex = '0x' + Number(decId).toString(16);
  if (await runX('wmctrl', ['-i', '-a', hex], 5000) !== null) return { ok: true };
  return { ok: false, error: 'no_window_tool' };
}

// The owning pid, without needing xdotool: it is a property on the window.
async function windowPid(hexId) {
  const raw = await runX('xprop', ['-id', hexId, '_NET_WM_PID'], 3000);
  const m = String(raw || '').match(/_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/);
  return m ? m[1] : '';
}

async function closeWindow(decId) {
  const hex = '0x' + Number(decId).toString(16);
  const pid = await windowPid(hex);
  const exe = pid ? await appFromExe(pid) : { path: '', name: '' };
  const props = await windowProps(hex);
  if (PROTECTED_CLASSES.has(props.cls)) {
    return { ok: false, error: 'protected', app: props.cls };
  }
  // wmctrl -c sends the EWMH _NET_CLOSE_WINDOW request: a graceful close the app
  // can still veto (save prompt), mirroring the Windows CloseMainWindow path.
  // Deliberately never falls back to killing the pid: the contract here is
  // "ask the app to close", and a SIGTERM would discard unsaved work.
  const out = await runX('wmctrl', ['-i', '-c', hex], 5000);
  if (out === null) return { ok: false, error: 'no_window_tool', app: props.cls || exe.name || '', path: exe.path };
  return { ok: true, app: props.cls || exe.name || '', path: exe.path };
}

async function windows(action, id) {
  if (action === 'focus') return focusWindow(id);
  if (action === 'close') return closeWindow(id);
  return listWindows();
}

// --- Audio: PipeWire (pw-dump for reads, wpctl for writes) ------------------
// Xenon's audio mixer drives everything through SoundVolumeView.exe (a Windows
// NirSoft tool). We reproduce two things:
//   - audioRows()     -> rows in SoundVolumeView's /scomma column layout (the
//     F.* indices), so _getAudioInfoRaw() and /audio/apps work unchanged.
//   - audioCommand()  -> translates one SoundVolumeView invocation (/SetVolume,
//     /ChangeVolume, /Mute, /Unmute, /Switch, /SetDefault) into wpctl.
//
// Volumes come out of the pw-dump payload itself rather than a wpctl call per
// node. Note the scale: PipeWire stores CUBIC volume in channelVolumes, and
// what wpctl prints (and what the user sees) is its cube root. Reading
// channelVolumes directly without the cbrt would report 7% for a sink actually
// sitting at 42%.
const cubicToLinear = (v) => Math.cbrt(Math.max(0, Number(v) || 0));

function audioEnv() {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR) {
    try { env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`; } catch { /* no getuid */ }
  }
  return env;
}
function audioRun(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, env: audioEnv(), windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

// Parse a pw-dump payload into the audio nodes we care about, with volume.
function parsePwDump(raw) {
  let dump;
  try { dump = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(dump)) return null;

  let defSink = '';
  let defSource = '';
  const sinks = [];
  const sources = [];
  const outStreams = [];
  const inStreams = [];

  for (const o of dump) {
    if (o && o.type === 'PipeWire:Interface:Metadata' &&
        o.props && o.props['metadata.name'] === 'default') {
      for (const m of (o.metadata || [])) {
        if (m.key === 'default.audio.sink' && m.value) defSink = m.value.name || '';
        if (m.key === 'default.audio.source' && m.value) defSource = m.value.name || '';
      }
    }
    if (!o || o.type !== 'PipeWire:Interface:Node') continue;
    const info = o.info || {};
    const p = info.props || {};
    const cls = p['media.class'];

    // Volume + mute live in the Props param on the node itself.
    let volume = 0;
    let muted = false;
    const propsParam = ((info.params || {}).Props || [])[0];
    if (propsParam) {
      muted = propsParam.mute === true;
      const cv = propsParam.channelVolumes;
      if (Array.isArray(cv) && cv.length) volume = Math.round(cubicToLinear(cv[0]) * 100);
      else if (propsParam.volume != null) volume = Math.round(cubicToLinear(propsParam.volume) * 100);
    }

    const node = {
      id: o.id,
      name: p['node.name'] || '',
      desc: p['node.description'] || p['node.nick'] || p['node.name'] || 'Audio device',
      appName: p['application.name'] || '',
      binary: p['application.process.binary'] || '',
      pid: p['application.process.id'] || '',
      mediaName: p['media.name'] || '',
      volume,
      muted,
    };
    if (cls === 'Audio/Sink') sinks.push(node);
    else if (cls === 'Audio/Source' && !node.name.endsWith('.monitor')) sources.push(node);
    else if (cls === 'Stream/Output/Audio') outStreams.push(node);
    else if (cls === 'Stream/Input/Audio') inStreams.push(node);
  }
  return { defSink, defSource, sinks, sources, outStreams, inStreams };
}

async function pwNodes() {
  // Let the spawn failure propagate: a missing pw-dump must surface as "audio
  // unavailable", not as an empty (but apparently working) mixer.
  const parsed = parsePwDump(await audioRun('pw-dump', [], 5000));
  if (!parsed) throw new Error('pw-dump returned unparseable output');
  return parsed;
}

// SoundVolumeView /scomma column indices (see the F.* map in server.js).
const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18, PROC_PATH: 19, PROC_ID: 20, WINDOW_TITLE: 21 };

// Build rows matching SoundVolumeView's /scomma layout from parsed pw-dump data.
function buildAudioRows(n) {
  const rows = [];
  const row = () => new Array(22).fill('');

  const addDevice = (node, dir, isDefault) => {
    const r = row();
    r[F.NAME] = node.desc;
    r[F.TYPE] = 'Device';
    r[F.DIR] = dir; // Render | Capture
    r[F.DEVICE_NAME] = node.desc;
    r[F.DEFAULT] = isDefault ? dir : '';
    r[F.STATE] = 'Active';
    r[F.MUTED] = node.muted ? 'Yes' : 'No';
    r[F.VOL_PCT] = String(node.volume);
    r[F.CLI_ID] = String(node.id);
    rows.push(r);
  };
  const addApp = (node, dir) => {
    const r = row();
    // Bare binary name (no path separator) so server's split('\\').pop() yields it.
    const proc = node.binary || (node.appName || 'app').toLowerCase().replace(/\s+/g, '');
    r[F.NAME] = node.appName || proc;
    r[F.TYPE] = 'Application';
    r[F.DIR] = dir;
    r[F.STATE] = 'Active';
    r[F.MUTED] = node.muted ? 'Yes' : 'No';
    r[F.VOL_PCT] = String(node.volume);
    r[F.CLI_ID] = String(node.id);
    r[F.PROC_PATH] = proc; // durable target; audioCommand maps "<proc>.exe" back
    r[F.PROC_ID] = String(node.pid || '');
    r[F.WINDOW_TITLE] = node.mediaName || '';
    rows.push(r);
  };

  n.sinks.forEach((s) => addDevice(s, 'Render', s.name === n.defSink));
  n.sources.forEach((s) => addDevice(s, 'Capture', s.name === n.defSource));
  n.outStreams.forEach((s) => addApp(s, 'Render'));
  n.inStreams.forEach((s) => addApp(s, 'Capture'));
  return rows;
}

// Rows are rebuilt at most this often: several dashboard surfaces can ask for
// audio on the same tick, and each rebuild forks pw-dump.
const AUDIO_ROWS_TTL_MS = 900;
let audioRowsCache = { rows: null, at: 0 };

async function audioRows() {
  const now = Date.now();
  if (audioRowsCache.rows && (now - audioRowsCache.at) < AUDIO_ROWS_TTL_MS) {
    return audioRowsCache.rows;
  }
  const rows = buildAudioRows(await pwNodes());
  audioRowsCache = { rows, at: Date.now() };
  return rows;
}

// Resolve a SoundVolumeView write target to one or more PipeWire node ids.
function resolveTargets(n, target) {
  const t = String(target || '').trim();
  if (/^\d+$/.test(t)) return [Number(t)];
  if (t === 'DefaultCaptureDevice' || t === 'DefaultRenderDevice') {
    const capture = t === 'DefaultCaptureDevice';
    const want = capture ? n.defSource : n.defSink;
    const list = capture ? n.sources : n.sinks;
    const hit = list.find((x) => x.name === want);
    return hit ? [hit.id] : [];
  }
  // App target: "<binary>.exe" or a bare name -> every matching stream node.
  const name = t.replace(/\.exe$/i, '').toLowerCase();
  // An empty name must match NOTHING. The substring fallback below ends in
  // `.includes(name)`, and `''.includes('')` is true, so a blank target used to
  // select every stream on the machine — a `/audio/app/mute` with proc="   " or
  // any svvExec fired before cachedSpeakerId was resolved would have muted the
  // whole system. The caller turns an empty list into a reported failure, which
  // is what the two sibling collectors do with the same input.
  if (!name) return [];
  return [...n.outStreams, ...n.inStreams]
    .filter((s) => (s.binary || '').toLowerCase() === name ||
                   (s.appName || '').toLowerCase().replace(/\s+/g, '') === name ||
                   (s.appName || '').toLowerCase().includes(name))
    .map((s) => s.id);
}

// Map one SoundVolumeView invocation onto wpctl. args mirror the SVV CLI.
// Throws when the target matched nothing, so the caller reports a failure
// rather than confirming an action that never reached the audio server.
async function audioCommand(args) {
  const list = Array.isArray(args) ? args : [];
  const action = list[0];
  if (action === '/scomma') return; // reads are served by audioRows()
  const n = await pwNodes();
  const ids = resolveTargets(n, list[1]);
  if (!ids.length) throw new Error(`no audio node matches "${list[1]}"`);
  // Drop the cached rows: a volume or mute change must be visible on the very
  // next read, not up to a TTL later.
  audioRowsCache = { rows: null, at: 0 };
  for (const id of ids) {
    if (action === '/SetVolume') {
      const pct = Math.max(0, Math.min(100, parseInt(list[2], 10) || 0));
      await audioRun('wpctl', ['set-volume', String(id), (pct / 100).toFixed(3)], 3000);
    } else if (action === '/ChangeVolume') {
      const step = parseInt(list[2], 10) || 0;
      await audioRun('wpctl', ['set-volume', String(id), `${Math.abs(step) / 100}${step < 0 ? '-' : '+'}`], 3000);
    } else if (action === '/Mute') {
      await audioRun('wpctl', ['set-mute', String(id), '1'], 3000);
    } else if (action === '/Unmute') {
      await audioRun('wpctl', ['set-mute', String(id), '0'], 3000);
    } else if (action === '/Switch') {
      await audioRun('wpctl', ['set-mute', String(id), 'toggle'], 3000);
    } else if (action === '/SetDefault') {
      await audioRun('wpctl', ['set-default', String(id)], 3000);
    } else {
      throw new Error(`unsupported audio action "${action}"`);
    }
  }
}

// Cheap capability probe for /actions: is a usable PipeWire mixer present?
// A YES is cached forever, a NO only for a cooldown: the backend's login
// service can win the race against PipeWire at session start, and a failure
// cached for the whole uptime would hide every audio Deck key until the next
// reboot — "not ready yet" and "not installed" are indistinguishable here, so
// only the answer that cannot change is allowed to stick.
const AUDIO_PROBE_RETRY_MS = 60000;
let _audioProbe = null;
let _audioProbeAt = 0;
async function audioAvailable() {
  if (_audioProbe !== null) {
    const ok = await _audioProbe;
    if (ok || Date.now() - _audioProbeAt <= AUDIO_PROBE_RETRY_MS) return ok;
  }
  _audioProbeAt = Date.now();
  _audioProbe = pwNodes().then(() => true).catch(() => false);
  return _audioProbe;
}

// Lock the screen now — the Deck's lockWorkstation key. loginctl asks the
// session's own locker, which is why it is the one call that works under both
// X11 and Wayland where the screensaver D-Bus names do not.
async function lock() {
  await run('loginctl', ['lock-session'], 5000);
}

// --- Sending a key combination ----------------------------------------------
// The Linux half of server.js's sendHotkey: the Deck's `hotkey` action, and
// answering a Teams/Zoom call (both are in-app shortcuts, so the caller focuses
// the window first and this only delivers the keys).
//
// Two tools, and which one is available is a property of the SESSION, not of
// the distro. xdotool speaks a combo directly and is already an optional
// dependency here for the app switcher — but it goes through the X server, so
// under Wayland it reaches nothing. Wayland deliberately forbids one client
// from synthesising input into another, so the only route left is ydotool,
// which writes to /dev/uinput underneath the compositor and needs its daemon
// (or uinput permissions) set up by the user first.
//
// That is why this capability is optional on Linux and declared rather than
// assumed: on a Wayland desktop with no ydotool there is no way to press a key
// in another application, and the call card must not offer a button for it.

// evdev keycodes (linux/input-event-codes.h). ydotool's `key` takes
// `CODE:STATE` pairs only — it has no name parser — so the table is written
// out. Only the tokens the action registry already accepts are here; anything
// else has been rejected long before it reaches this function.
const YDOTOOL_CODES = {
  ctrl: 29, control: 29, shift: 42, alt: 56, win: 125, cmd: 125, meta: 125, super: 125,
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36, k: 37, l: 38, m: 50,
  n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20, u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11,
  enter: 28, return: 28, esc: 1, escape: 1, tab: 15, space: 57, backspace: 14,
  delete: 111, del: 111, home: 102, end: 107, pageup: 104, pagedown: 109,
  up: 103, down: 108, left: 105, right: 106, insert: 110,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  f11: 87, f12: 88,
};

// "ctrl+shift+s" → the press/release sequence ydotool wants, modifiers held
// around the key and released in reverse order. Returns '' when any token has
// no code, so a combo is either sent whole or not at all.
const YDOTOOL_MODIFIERS = new Set(['ctrl', 'control', 'shift', 'alt', 'win', 'cmd', 'meta', 'super']);

function ydotoolArgs(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  // Exactly one non-modifier, like the action registry's own normalizeKeys.
  // Without this "ctrl+" produced a press/release of Ctrl alone: harmless by
  // luck here because the release is emitted too, but it is a combo that was
  // asked for and not delivered, reported as success. A combo is sent whole or
  // refused.
  const mainKeys = parts.filter(p => !YDOTOOL_MODIFIERS.has(p));
  if (mainKeys.length !== 1) return null;
  const codes = [];
  for (const p of parts) {
    const code = YDOTOOL_CODES[p];
    if (code === undefined) return null;
    codes.push(code);
  }
  const down = codes.map(c => `${c}:1`);
  const up = codes.slice().reverse().map(c => `${c}:0`);
  return down.concat(up);
}

let _keysProbe = null;
// Which sender this session has, if any. Cached: it is read on the path that
// decides whether to draw an Answer button, and neither tool appears or
// disappears while the server runs.
async function keysTool() {
  if (_keysProbe !== null) return _keysProbe;
  const wayland = !!(process.env.WAYLAND_DISPLAY || String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland');
  const probe = async (bin, args) => {
    try { await run(bin, args, 3000); return true; } catch { return false; }
  };
  // Under Wayland xdotool may well be installed and still deliver nothing, so
  // it is not even tried there — offering a button that silently fails is the
  // failure this whole feature is written to avoid.
  if (!wayland && await probe('xdotool', ['--version'])) _keysProbe = 'xdotool';
  else if (await probe('ydotool', ['--help'])) _keysProbe = 'ydotool';
  else _keysProbe = '';
  return _keysProbe;
}

async function keysAvailable() { return !!(await keysTool()); }

async function sendKeys(combo) {
  const tool = await keysTool();
  if (!tool) return { ok: false, error: 'no_key_tool' };
  if (tool === 'xdotool') {
    // --clearmodifiers so a modifier the user is physically holding does not
    // combine into a different shortcut than the one requested.
    try { await run('xdotool', ['key', '--clearmodifiers', String(combo)], 5000); return { ok: true }; }
    catch { return { ok: false, error: 'xdotool_failed' }; }
  }
  const args = ydotoolArgs(combo);
  if (!args) return { ok: false, error: 'bad_combo' };
  try { await run('ydotool', ['key', ...args], 5000); return { ok: true }; }
  catch { return { ok: false, error: 'ydotool_failed' }; }
}

// --- Per-process CPU/RAM for the `processes` stream -------------------------
// One read of /proc/<pid>/stat per process carries BOTH the cumulative CPU time
// and the resident set, so this needs no external tool and no second file.
//
// Per-process GPU is deliberately absent rather than approximated. It exists on
// Linux only through DRM fdinfo (i915/amdgpu, recent kernels) or `nvidia-smi
// pmon`, each covering one vendor and neither covering a hybrid laptop
// correctly. `gpuAvail: false` makes the widget hide the column and say why,
// which is the honest answer; a column of zeros would read as "nothing is using
// the GPU" and be worse than no column at all.
//
// /proc/[pid]/stat fields are 1-indexed in proc(5). comm (field 2) is wrapped in
// parentheses AND may itself contain spaces and parentheses — "((sd-pam))" is
// real — so it is cut at the LAST ')' rather than tokenised.
const USER_HZ = 100;   // fixed by the kernel ABI for /proc/[pid]/stat, not by CONFIG_HZ

function parseProcStat(text) {
  const line = String(text || '').trim();
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(line.slice(0, open).trim());
  const name = line.slice(open + 1, close);
  if (!Number.isInteger(pid) || pid <= 0 || !name) return null;
  // After the closing paren the first token is field 3 (state), so field N sits
  // at index N-3: utime=14 -> 11, stime=15 -> 12, rss=24 -> 21.
  const rest = line.slice(close + 1).trim().split(/\s+/);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return {
    pid,
    name,
    cpuMs: ((utime + stime) / USER_HZ) * 1000,
    rssPages: Number.isFinite(rssPages) && rssPages > 0 ? rssPages : 0,
  };
}

// The page size is needed to turn stat's rss (in pages) into bytes, and Node
// exposes no sysconf(_SC_PAGESIZE). Deriving it once from OUR OWN process — where
// both spellings of the same number are readable — is exact on 4K x86 and on the
// 16K/64K ARM kernels a hardcoded 4096 would under-report by 4x or 16x.
let _pageSize = 0;
async function pageSize() {
  if (_pageSize) return _pageSize;
  _pageSize = 4096;
  try {
    const self = parseProcStat(await fsp.readFile('/proc/self/stat', 'utf8'));
    const rssBytes = process.memoryUsage().rss;
    if (self && self.rssPages > 0 && rssBytes > 0) {
      const guess = rssBytes / self.rssPages;
      for (const candidate of [4096, 8192, 16384, 65536]) {
        if (guess >= candidate * 0.75 && guess <= candidate * 1.5) { _pageSize = candidate; break; }
      }
    }
  } catch { /* keep 4096 */ }
  return _pageSize;
}

async function sampleProcesses() {
  const size = await pageSize();
  let entries = [];
  try { entries = await fsp.readdir('/proc'); } catch { return null; }
  const pids = entries.filter((e) => /^\d+$/.test(e));
  const sample = new Map();
  // Bounded concurrency: /proc reads are cheap but a 500-process box would open
  // 500 descriptors in one tick without it.
  await mapLimit(pids, 64, async (dir) => {
    let raw = null;
    try { raw = await fsp.readFile('/proc/' + dir + '/stat', 'utf8'); } catch { return; }
    const row = parseProcStat(raw);
    if (row) sample.set(row.pid, { name: row.name, cpuMs: row.cpuMs, rss: row.rssPages * size });
  });
  return sample.size ? sample : null;
}

const PROC_STALE_MS = 30000;
const PROC_PRIME_MS = 250;
let _procPrev = null;
let _procPrevAt = 0;

async function processes(top = 8) {
  let curr = await sampleProcesses();
  if (!curr) return { ok: false, error: 'no_procfs' };
  let now = Date.now();
  // First call, or a gap long enough that the delta would be a guess: prime with
  // a short window so THIS call already answers with real numbers. Paid once per
  // stream start, never in the steady state.
  if (!_procPrev || !_procPrevAt || now - _procPrevAt > PROC_STALE_MS) {
    _procPrev = curr;
    _procPrevAt = now;
    await new Promise((r) => setTimeout(r, PROC_PRIME_MS));
    curr = await sampleProcesses();
    if (!curr) return { ok: false, error: 'no_procfs' };
    now = Date.now();
  }
  const windowMs = Math.max(1, now - _procPrevAt);
  const cores = Math.max(1, os.cpus().length);
  const all = procStats.aggregate(_procPrev, curr, { windowMs, cores });
  const apps = procStats.topUnion(all, top);
  _procPrev = curr;
  _procPrevAt = now;
  const mem = await memory();
  return {
    ok: true,
    cpu: procStats.totalCpu(all),
    // No per-adapter breakdown here: per-process GPU does not exist on Linux
    // without vendor-specific plumbing, so there is nothing to attribute.
    gpus: [],
    cores,
    totalMB: Math.round((mem.total || 0) / (1024 * 1024)),
    usedMB: Math.round((mem.used || 0) / (1024 * 1024)),
    gpuAvail: false,
    win: windowMs,
    apps,
  };
}

module.exports = {
  gpu, disks, cpuTemp, memory, network, windows, audioRows, audioCommand, audioAvailable, lock,
  sendKeys, keysAvailable, processes,
  // exported for unit tests
  parseProcStat,
  parseGpu, parseSysfsGpu, rc6Busy, betterGpuCandidate, parseHwmonFans, parseDisks, parseMemInfo, parseNetDev, parsePing,
  parseWmctrl, parseWindowProps, parseClientList, parseWindowIdentity,
  parsePwDump, buildAudioRows, resolveTargets, cubicToLinear,
  ydotoolArgs,
};
