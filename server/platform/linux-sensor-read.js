'use strict';
// The graphics card and the sensors on Linux, read live.

const fsp = require('node:fs').promises;
const { run, readText } = require('./linux-read.js');
const { EMPTY_GPU, parseGpu, sysfsGpu, NVIDIA_SMI_RETRY_MS } = require('./linux-gpu.js');
const { held } = require('./linux-held.js');
const {
  HWMON_CHIPS_MAX, hwmonDevKey, parseHwmonReading, HWMON_INDEX_TTL_MS, HWMON_REWALK_MIN_MS,
  readChipFiles,
} = require('./linux-hwmon.js');

async function nvidiaGpu() {
  if (Date.now() - held.nvidiaSmiMissingAt < NVIDIA_SMI_RETRY_MS) return null;
  try {
    return parseGpu(await run('nvidia-smi',
      ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,clocks.gr,clocks.mem,name',
       '--format=csv,noheader,nounits'], 5000));
  } catch (err) {
    if (err && err.code === 'ENOENT') held.nvidiaSmiMissingAt = Date.now();
    return null;
  }
}

async function gpu() {
  const nvidia = await nvidiaGpu();
  if (nvidia) return nvidia;
  // No NVIDIA driver (or no nvidia-smi): fall through to the kernel's own
  // files, which is the whole AMD story and half of the Intel one.
  try {
    const fromSysfs = await sysfsGpu();
    if (fromSysfs) return fromSysfs;
  } catch { /* fall through to empty */ }
  return { ...EMPTY_GPU };
}

async function listSensors() {
  const out = [];
  const index = new Map();
  const base = '/sys/class/hwmon';
  let dirs = [];
  try { dirs = (await fsp.readdir(base)).slice(0, HWMON_CHIPS_MAX); } catch { return out; }
  for (const d of dirs) {
    const dir = `${base}/${d}`;
    let chip = '';
    try { chip = (await readText(`${dir}/name`)).replace(/[^A-Za-z0-9_.+-]/g, '_').slice(0, 32); } catch { continue; }
    if (!chip) continue;
    let devKey = 'virtual';
    try { devKey = hwmonDevKey(await fsp.realpath(`${dir}/device`)); } catch { /* a virtual chip has no device */ }
    await readChipFiles(dir, chip, devKey, index, out);
  }
  // Two chips of one driver (two NVMe drives) carry their device in the name,
  // so the picker can tell them apart.
  const devices = new Map();
  for (const meta of index.values()) devices.set(meta.chip, (devices.get(meta.chip) || new Set()).add(meta.devKey));
  for (const e of out) {
    const meta = index.get(e.id);
    if (devices.get(meta.chip).size > 1) { meta.hw = `${meta.chip} ${meta.devKey}`; e.hw = meta.hw; }
  }
  held.hwmonIndex = index;
  held.hwmonIndexAt = Date.now();
  return out;
}

async function readSensors(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string');
  if (!wanted.length) return [];
  const stale = Date.now() - held.hwmonIndexAt > HWMON_INDEX_TTL_MS || wanted.some((id) => !held.hwmonIndex.has(id));
  if (stale && Date.now() - held.hwmonIndexAt > HWMON_REWALK_MIN_MS) await listSensors();
  const out = [];
  for (const id of wanted) {
    const meta = held.hwmonIndex.get(id);
    if (!meta) continue;
    let raw;
    try { raw = await readText(meta.file); } catch { continue; }
    const e = parseHwmonReading(meta.chip, meta.devKey, meta.file.split('/').pop(), raw, meta.label);
    if (e) out.push({ ...e, hw: meta.hw });
  }
  return out;
}

module.exports = { nvidiaGpu, gpu, listSensors, readSensors };
