'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// doctor-checks.mjs — what "this collector works" actually means.
//
// The pure half of `npm run doctor`. Every function here takes what a collector
// returned and answers whether it satisfies the contract server.js consumes —
// the SAME contract the Windows collectors define, since nothing above the seam
// knows which platform produced the data.
//
// It is split out for one reason: this repo is developed on Windows, and a
// diagnostic that has never been run is worth as little as the code it is meant
// to check. These functions are unit-tested against the same fixtures the
// collector tests use, so the only part that reaches a Mac untested is the
// plumbing that calls the collectors.
//
// A check reports one of three things, and the difference matters:
//   ok    — the value satisfies the contract
//   warn  — the shape is right but the data is absent (a sensor this machine
//           does not expose). The tile shows "--", which is a supported state.
//   fail  — the shape is wrong. Something above the seam WILL misread it.
// ─────────────────────────────────────────────────────────────────────────────

const ok = (summary, notes = []) => ({ level: 'ok', summary, notes });
const warn = (summary, notes = []) => ({ level: 'warn', summary, notes });
const fail = (summary, notes = []) => ({ level: 'fail', summary, notes });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v) => v === null || v === undefined || isNum(v);
const isStr = (v) => typeof v === 'string';

function bytes(n) {
  if (!isNum(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// disks() → the drive objects the Disks tile and the disk widget read. `used`
// is the one field a df-based implementation gets wrong most easily: on APFS it
// must be total - free, never df's own Used column, which excludes purgeable
// space and makes the bar disagree with Finder.
export function checkDisks(rows) {
  if (rows === null || rows === undefined) return warn('no drives reported', ['The tile shows no drives. Expected only if the enumeration failed.']);
  if (!Array.isArray(rows)) return fail(`expected an array, got ${typeof rows}`);
  if (!rows.length) return warn('the drive list is empty');
  const problems = [];
  for (const d of rows) {
    const where = d && d.drive ? `drive ${d.drive}` : 'a drive with no name';
    if (!d || typeof d !== 'object') { problems.push('a non-object entry'); continue; }
    if (!isStr(d.drive) || !d.drive) problems.push(`${where}: missing drive`);
    for (const k of ['total', 'used', 'free', 'percent']) {
      if (!isNum(d[k])) problems.push(`${where}: ${k} is not a number (${JSON.stringify(d[k])})`);
    }
    if (isNum(d.total) && isNum(d.used) && isNum(d.free)) {
      if (d.used < 0 || d.free < 0) problems.push(`${where}: negative used/free`);
      // total-free-used must agree within rounding, or the bar and the label
      // in the widget disagree with each other on the same tile.
      if (d.total > 0 && Math.abs(d.total - (d.used + d.free)) > d.total * 0.02) {
        problems.push(`${where}: used+free (${bytes(d.used + d.free)}) does not match total (${bytes(d.total)})`);
      }
    }
    if (isNum(d.percent) && (d.percent < 0 || d.percent > 100)) problems.push(`${where}: percent out of range (${d.percent})`);
  }
  if (problems.length) return fail(`${rows.length} drive(s), ${problems.length} problem(s)`, problems);
  const list = rows.map((d) => `${d.drive} ${bytes(d.used)}/${bytes(d.total)} (${d.percent}%)`);
  return ok(`${rows.length} drive(s)`, list);
}

// gpu() → load/temperature/VRAM. Every field is legitimately null where the
// platform does not expose it (Apple Silicon has no separate VRAM at all — it
// is unified memory, so 0 is the correct answer, not a missing one).
export function checkGpu(g) {
  if (!g || typeof g !== 'object') return fail(`expected an object, got ${typeof g}`);
  const problems = [];
  for (const k of ['gpu', 'gpuTemp', 'vramUsed', 'vramTotal']) {
    if (!isNumOrNull(g[k])) problems.push(`${k} is neither a number nor null (${JSON.stringify(g[k])})`);
  }
  if (g.gpuName !== undefined && g.gpuName !== null && !isStr(g.gpuName)) problems.push('gpuName is not a string');
  if (isNum(g.gpu) && (g.gpu < 0 || g.gpu > 100)) problems.push(`gpu load out of range (${g.gpu})`);
  if (problems.length) return fail('bad shape', problems);
  const notes = [
    `name: ${g.gpuName || '(none)'}`,
    `load: ${isNum(g.gpu) ? g.gpu + '%' : '--'}`,
    `temp: ${isNum(g.gpuTemp) ? g.gpuTemp + '°C' : '--'}`,
    `vram: ${isNum(g.vramTotal) && g.vramTotal > 0 ? `${bytes(g.vramUsed || 0)}/${bytes(g.vramTotal)}` : '-- (unified memory reports 0, which is correct)'}`,
  ];
  if (!isNum(g.gpu) && !isNum(g.gpuTemp)) {
    return warn('no load or temperature', [
      ...notes,
      'macOS: the Xenon Helper reads both and needs nothing installed — check server/helper/xenon-helper exists.',
      'macOS without the helper: macmon on PATH is the fallback (brew install vladkens/tap/macmon).',
      'Linux: nvidia-smi, or an AMD/Intel card exposing itself under /sys/class/drm.',
    ]);
  }
  return ok('reporting', notes);
}

export function checkCpuTemp(t) {
  if (!t || typeof t !== 'object') return fail(`expected an object, got ${typeof t}`);
  if (!isNumOrNull(t.cpuTemp)) return fail(`cpuTemp is neither a number nor null (${JSON.stringify(t.cpuTemp)})`);
  if (!isNum(t.cpuTemp)) {
    return warn('no CPU temperature on this machine', [
      'macOS: the Xenon Helper reads the sensors directly — check server/helper/xenon-helper exists; macmon on PATH is the fallback.',
      'Linux: it needs the board to expose it under /sys/class/hwmon.',
    ]);
  }
  if (t.cpuTemp <= 0 || t.cpuTemp > 130) return fail(`implausible CPU temperature (${t.cpuTemp}°C)`);
  return ok(`${t.cpuTemp}°C`);
}

// network() → cumulative counters plus latency. server.js turns the counters
// into a rate by differencing them, so they MUST be monotonic totals since
// boot; handing it a per-second value makes the throughput graph nonsense.
export function checkNetwork(n) {
  if (!n || typeof n !== 'object') return fail(`expected an object, got ${typeof n}`);
  const problems = [];
  for (const k of ['rxBytes', 'txBytes']) {
    if (!isNumOrNull(n[k])) problems.push(`${k} is neither a number nor null`);
    if (isNum(n[k]) && n[k] < 0) problems.push(`${k} is negative`);
  }
  for (const k of ['ping', 'latency']) {
    if (!isNumOrNull(n[k])) problems.push(`${k} is neither a number nor null`);
  }
  if (problems.length) return fail('bad shape', problems);
  const notes = [
    `rx/tx since boot: ${bytes(n.rxBytes)} / ${bytes(n.txBytes)}`,
    `ping: ${isNum(n.ping) ? n.ping + ' ms' : '--'}`,
  ];
  if (!isNum(n.rxBytes) && !isNum(n.txBytes)) return warn('no interface counters', notes);
  return ok('reporting', notes);
}

// windows(action) → the app-switcher contract. An empty list is a SUPPORTED
// answer (macOS until the Automation permission is granted, Linux outside X11);
// a wrong shape is not.
export function checkWindows(w) {
  if (!w || typeof w !== 'object') return fail(`expected an object, got ${typeof w}`);
  if (!Array.isArray(w.windows)) return fail('missing the `windows` array');
  const problems = [];
  for (const it of w.windows) {
    if (!it || typeof it !== 'object') { problems.push('a non-object entry'); continue; }
    if (!isStr(it.id) || !/^\d{1,24}$/.test(it.id)) problems.push(`id ${JSON.stringify(it.id)} is not the digit string server.js validates`);
    for (const k of ['title', 'app']) if (!isStr(it[k])) problems.push(`${k} is not a string`);
    if (typeof it.active !== 'boolean') problems.push('active is not a boolean');
  }
  if (problems.length) return fail(`${w.windows.length} window(s), ${problems.length} problem(s)`, problems.slice(0, 8));
  if (!w.windows.length) {
    return warn('no open applications reported', [
      'macOS: expected until you grant the Automation permission (System Settings → Privacy & Security → Automation).',
      'Linux: the list is read with xprop (x11-utils) and covers X11 windows only.',
      'Under a Wayland session only apps running through Xwayland appear — Wayland has no protocol letting a background app enumerate windows.',
    ]);
  }
  return ok(`${w.windows.length} application(s)`, w.windows.slice(0, 6).map((x) => `${x.app}${x.active ? ' (frontmost)' : ''}`));
}

// audioRows() → SoundVolumeView's 22-column /scomma layout. Every consumer
// indexes it positionally, so a short row is read as a device with no name.
export const AUDIO_COLS = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18 };

export function checkAudioRows(rows) {
  if (!Array.isArray(rows)) return fail(`expected an array, got ${typeof rows}`);
  if (!rows.length) return fail('no audio rows — the volume tile and the mic button have nothing to show');
  const problems = [];
  for (const r of rows) {
    if (!Array.isArray(r)) { problems.push('a non-array row'); continue; }
    if (r.length !== 22) problems.push(`a row has ${r.length} columns, not 22 (every consumer indexes positionally)`);
    if (!isStr(r[AUDIO_COLS.NAME]) || !r[AUDIO_COLS.NAME]) problems.push('a row has no NAME');
    if (!['Device', 'Application'].includes(r[AUDIO_COLS.TYPE])) problems.push(`unexpected TYPE ${JSON.stringify(r[AUDIO_COLS.TYPE])}`);
    if (!['Render', 'Capture'].includes(r[AUDIO_COLS.DIR])) problems.push(`unexpected DIR ${JSON.stringify(r[AUDIO_COLS.DIR])}`);
    if (!isStr(r[AUDIO_COLS.CLI_ID]) || !r[AUDIO_COLS.CLI_ID]) problems.push(`row ${r[AUDIO_COLS.NAME]} has no CLI_ID — every write addresses a device by it`);
  }
  const devices = rows.filter((r) => Array.isArray(r) && r[AUDIO_COLS.TYPE] === 'Device' && r[AUDIO_COLS.STATE] === 'Active');
  const outs = devices.filter((r) => r[AUDIO_COLS.DIR] === 'Render');
  const ins = devices.filter((r) => r[AUDIO_COLS.DIR] === 'Capture');
  if (!outs.length) problems.push('no active output device — the volume slider will not bind');
  if (!ins.length) problems.push('no active input device — the mic mute button will not bind');
  // Exactly one default per direction, or server.js caches the wrong id and
  // every subsequent write lands on the wrong device.
  for (const [dir, list] of [['Render', outs], ['Capture', ins]]) {
    const defaults = list.filter((r) => r[AUDIO_COLS.DEFAULT] === dir);
    if (defaults.length > 1) problems.push(`${defaults.length} devices claim to be the default ${dir}`);
  }
  if (problems.length) return fail(`${rows.length} row(s), ${problems.length} problem(s)`, problems.slice(0, 8));
  const name = (list, dir) => {
    const d = list.find((r) => r[AUDIO_COLS.DEFAULT] === dir) || list[0];
    return `${d[AUDIO_COLS.NAME]}${d[AUDIO_COLS.VOL_PCT] ? ` at ${d[AUDIO_COLS.VOL_PCT]}%` : ''}`;
  };
  return ok(`${outs.length} output(s), ${ins.length} input(s)`, [
    `default output: ${name(outs, 'Render')}`,
    `default input:  ${name(ins, 'Capture')}`,
  ]);
}

// The media object every surface reads. "Nothing playing" is a full answer, so
// it is only a warning when the caller says something SHOULD be playing.
export function checkMedia(info, expectPlaying = false) {
  if (!info || typeof info !== 'object') return fail(`expected an object, got ${typeof info}`);
  const problems = [];
  for (const k of ['app', 'source', 'title', 'artist', 'album', 'playbackStatus']) {
    if (!isStr(info[k])) problems.push(`${k} is not a string (${JSON.stringify(info[k])})`);
  }
  for (const k of ['position', 'duration']) if (!isNum(info[k])) problems.push(`${k} is not a number`);
  if (typeof info.active !== 'boolean') problems.push('active is not a boolean');
  if (info.thumbnail !== null && info.thumbnail !== undefined && !isStr(info.thumbnail)) problems.push('thumbnail is neither a string nor null');
  // The one field with a fixed vocabulary: liveMediaSnapshot compares it to
  // 'Playing' exactly, so a localized or differently-cased value silently
  // freezes the progress bar.
  const STATUSES = ['Playing', 'Paused', 'Stopped', 'Closed', 'Unknown', 'Unavailable'];
  if (isStr(info.playbackStatus) && !STATUSES.includes(info.playbackStatus)) {
    problems.push(`playbackStatus ${JSON.stringify(info.playbackStatus)} is outside the vocabulary ${STATUSES.join('/')}`);
  }
  if (isNum(info.duration) && isNum(info.position) && info.duration > 0 && info.position > info.duration + 1) {
    problems.push(`position (${info.position}s) is past duration (${info.duration}s)`);
  }
  if (info.thumbnail && isStr(info.thumbnail) && !/^(https?:|data:image\/)/.test(info.thumbnail)) {
    problems.push('thumbnail is neither an http(s) URL nor a data:image URI — it is rendered as an <img src>');
  }
  if (problems.length) return fail('bad shape', problems);
  if (!info.active) {
    const notes = ['Start something playing and run this again to see the full path.'];
    return expectPlaying ? warn('nothing playing', notes) : ok('nothing playing (a complete answer)', notes);
  }
  return ok(`${info.playbackStatus}: ${info.title || '(no title)'}`, [
    `app: ${info.app} (${info.source})`,
    `artist/album: ${info.artist || '--'} / ${info.album || '--'}`,
    `position: ${info.position}s of ${info.duration}s`,
    `artwork: ${info.thumbnail ? info.thumbnail.slice(0, 24) + '…' : 'none'}`,
  ]);
}

export const _internal = { bytes };
