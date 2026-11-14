'use strict';
// What /sys/class/hwmon says on Linux: the processor's temperature and clock, the fans, and one
// reading of any sensor file for the sensor catalog.

const fsp = require('node:fs').promises;
const { isNum, readText } = require('./linux-read.js');

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

// Current core clock, in MHz, from the kernel's own cpufreq files.
//
// The highest core rather than an average, matching cpu-temp.ps1: an average
// reads low the moment the governor idles half the cores, which on a desktop is
// most of the time. scaling_cur_freq is in kHz. A machine with no cpufreq driver
// (a VM, some ARM boards) has no such file and reports null rather than the
// nominal speed dressed up as the current one.
//
// One readdir plus one small read per core, all from a virtual filesystem — the
// same shape as the hwmon walk it rides along with, and cheap for the same
// reason: nothing here touches a disk.
// The pick, split from the read so it is testable off a machine with cpufreq —
// the same split parseHwmonFans uses. Takes what the files contained, in kHz.
function pickCpuClockMHz(rawKhzValues) {
  let best = null;
  for (const raw of rawKhzValues) {
    const khz = Number(raw);
    if (!Number.isFinite(khz) || khz <= 0) continue;
    const mhz = Math.round(khz / 1000);
    // A driver reporting nonsense and a value read mid-transition both land
    // here; neither is a clock a person would recognise.
    if (mhz < 100 || mhz > 10000) continue;
    if (best === null || mhz > best) best = mhz;
  }
  return best;
}

async function readCpuClockMHz() {
  const base = '/sys/devices/system/cpu/cpufreq';
  const values = [];
  try {
    for (const d of await fsp.readdir(base)) {
      if (!/^policy\d+$/.test(d)) continue;
      try { values.push(await readText(`${base}/${d}/scaling_cur_freq`)); } catch { /* gone mid-walk */ }
    }
  } catch { /* no cpufreq on this machine */ }
  return pickCpuClockMHz(values);
}

async function cpuTemp() {
  const [fans, cpuClockMHz] = await Promise.all([readHwmonFans(), readCpuClockMHz()]);
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
          if (Number.isFinite(milli)) return { cpuTemp: Math.round((milli / 1000) * 10) / 10, cpuTempSource: label || `temp${i}`, fans, cpuClockMHz };
        }
      }
    }
  } catch { /* no hwmon, or unreadable */ }
  return { cpuTemp: null, fans, cpuClockMHz };
}

// --- Sensor catalog: every hwmon reading, for Settings → Sensor sources -------
// The same shape sensors.ps1 gives on Windows ({ id, hw, hwKind, type, name,
// value }). An id names the chip by its driver AND the device it is bound to —
// hwmon/k10temp@0000:00:18.3/temp1 — because hwmonN is renumbered on every boot
// and the device is not. Ids are matched against this walk only: one sent back
// by the browser never becomes a path (see readSensors).
const HWMON_FILE_RE = /^(temp|fan|power|freq)(\d{1,2})_(input|average)$/;
const HWMON_TYPES = { temp: 'temperature', fan: 'fan', power: 'power', freq: 'clock' };
const HWMON_KINDS = [
  [/^(k10temp|coretemp|zenpower|cpu[_-]thermal)$/, 'cpu'],
  [/^(amdgpu|radeon|nouveau|i915|xe)$/, 'gpu'],
  [/^(nvme|drivetemp)$/, 'storage'],
  [/^(spd5118|jc42)$/, 'memory'],
  [/^corsairpsu$/, 'psu'],
  [/^(nzxt|kraken|aquacomputer|corsair-cpro|d5next|octo|quadro)/, 'cooler'],
  [/^(nct|it8|f71|w83|asus|gigabyte|dell_smm|thinkpad|applesmc|acpitz)/, 'board'],
];
const HWMON_CHIPS_MAX = 32;

function hwmonKind(chip) {
  for (const [re, kind] of HWMON_KINDS) if (re.test(chip)) return kind;
  return 'other';
}

// The part of the device path that names it (a PCI address, nct6775.656,
// nvme0), cut to the characters an id may carry.
function hwmonDevKey(realDevicePath) {
  const base = String(realDevicePath || '').split('/').filter(Boolean).pop() || 'virtual';
  return base.replace(/[^A-Za-z0-9_.:+-]/g, '_').slice(0, 48);
}

// Pure: one hwmon file's reading as a catalog entry, or null. Kernel units are
// millidegrees, RPM, microwatts and Hz; the catalog's are °C, RPM, W and MHz.
function parseHwmonReading(chip, devKey, file, raw, label) {
  const m = HWMON_FILE_RE.exec(file);
  if (!m || (m[3] === 'average' && m[1] !== 'power')) return null;
  const [, kind, idx] = m;
  let value = isNum(raw) ? Number(raw) : null;
  if (value !== null) {
    if (kind === 'temp') value = value > 200 ? value / 1000 : value;   // see parseSysfsGpu
    else if (kind === 'power' || kind === 'freq') value /= 1e6;
    value = Math.round(value * 10) / 10;
  }
  return {
    id: `hwmon/${chip}@${devKey}/${kind}${idx}`,
    hw: chip,
    hwKind: hwmonKind(chip),
    type: HWMON_TYPES[kind],
    name: String(label || '').trim() || `${kind}${idx}`,
    value,
  };
}

const HWMON_INDEX_TTL_MS = 60 * 1000;
const HWMON_REWALK_MIN_MS = 5000;

async function readChipFiles(dir, chip, devKey, index, out) {
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => HWMON_FILE_RE.test(f)); } catch { return; }
  // Every `_input` before any `_average`, so a chip offering both for one
  // sensor keeps the live reading; then natural order (temp2 before temp10).
  files.sort((a, b) => (a.endsWith('_average') - b.endsWith('_average')) || a.localeCompare(b, 'en', { numeric: true }));
  for (const f of files) {
    let raw;
    try { raw = await readText(`${dir}/${f}`); } catch { continue; }
    let label = '';
    try { label = await readText(`${dir}/${f.replace(/_(input|average)$/, '')}_label`); } catch { /* unlabelled */ }
    const e = parseHwmonReading(chip, devKey, f, raw, label);
    if (!e || index.has(e.id)) continue;
    index.set(e.id, { file: `${dir}/${f}`, chip, devKey, label, hw: chip });
    out.push(e);
  }
}

module.exports = {
  parseHwmonFans, readHwmonFans, pickCpuClockMHz, readCpuClockMHz, cpuTemp, HWMON_FILE_RE,
  HWMON_TYPES, HWMON_KINDS, HWMON_CHIPS_MAX, hwmonKind, hwmonDevKey, parseHwmonReading,
  HWMON_INDEX_TTL_MS, HWMON_REWALK_MIN_MS, readChipFiles,
};
