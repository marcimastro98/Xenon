'use strict';
// Airflow's driver for Linux: the kernel's own fan controls, /sys/class/hwmon/*/pwmN
// (0-255) with pwmN_enable (1 = manual; 0, 2 and up = full speed or the chip's own
// curve). There is no privileged helper here: the engine writes the files itself,
// which takes a udev rule granting its group write access (shown in the card).
//
// Before the first write to a channel its two original values are saved, in memory,
// to the store (so a later start in the same boot can put them back after a crash)
// and to the watchdog (a separate process that puts them back if the engine dies).
// If that save fails nothing is written. Handing a fan back writes the originals.
// Only the boards' Super I/O chips are the well-trodden path (fancontrol's). Any other
// chip with controls (an AMD card's amdgpu, a USB cooler's kernel driver: NZXT Kraken,
// Aquacomputer, ...) is beta: it drives a fan only once the fan check saw the fan go
// back when let go (calibrate-back.js). On RDNA3 and later an AMD card's fixed speed
// is often refused or ignored, which the check sees too. NVIDIA has no hwmon control.
const fs = require('fs');
const { isNum } = require('../platform/linux-read.js');
const { hwmonKind, hwmonDevKey, fanKind } = require('../platform/linux-hwmon.js');
const { fanId } = require('./inventory.js');

const ROOT = '/sys/class/hwmon';
const BOOT_ID = '/proc/sys/kernel/random/boot_id';
const MAX_CHIPS = 32;
const MAX_PWM = 8;
const MANUAL = 1;
// hwmonN is renumbered on a reboot or a replug: the chip list is walked again this often.
const RESCAN_MS = 60000;
const CHIP_DIR_RE = /^hwmon\d{1,3}$/;
const FAN_INPUT_RE = /^fan(\d{1,2})_input$/;
const MAX_TACH = 12;
const SUPER_IO_RE = /^(nct|it8|f71|w83)/;

const toRaw = (duty) => Math.round((Math.min(100, Math.max(0, duty)) * 255) / 100);
const toDuty = (raw) => Math.round((raw * 1000) / 255) / 10;
const celsius = (raw) => (isNum(raw) ? Math.round((Number(raw) > 200 ? Number(raw) / 1000 : Number(raw)) * 10) / 10 : null);

/** The two files of one channel, only ever built from a walked chip dir and an index. */
function pwmFiles(dir, i) {
  return { pwm: `${dir}/pwm${i}`, enable: `${dir}/pwm${i}_enable` };
}

// A path the store or the watchdog hands back is used only if it is one of ours.
function isPwmFile(root, file) {
  return typeof file === 'string' && file.startsWith(`${root}/`)
    && /^hwmon\d{1,3}\/pwm\d{1,2}(?:_enable)?$/.test(file.slice(root.length + 1));
}

async function readNum(fsp, file) {
  try { const t = (await fsp.readFile(file, 'utf8')).trim(); return isNum(t) ? Number(t) : null; } catch { return null; }
}
async function readLabel(fsp, file) {
  try { return (await fsp.readFile(file, 'utf8')).trim().slice(0, 48); } catch { return ''; }
}
async function writable(fsp, file) {
  try { await fsp.access(file, fs.constants.W_OK); return true; } catch { return false; }
}

// Where hwmonN really is: it names the device, so a number reused by another chip is noticed.
async function realDir(fsp, dir) {
  try { return await fsp.realpath(dir); } catch { return null; }
}

// The fanN_input files a chip has, found once per walk instead of probed every second.
async function fanIndexes(fsp, dir) {
  try {
    return (await fsp.readdir(dir)).map((n) => Number(FAN_INPUT_RE.exec(n)?.[1]))
      .filter((i) => i >= 1 && i <= MAX_TACH).sort((a, b) => a - b);
  } catch { return []; }
}

async function listChips(root, fsp) {
  let dirs = [];
  try { dirs = (await fsp.readdir(root)).filter((d) => CHIP_DIR_RE.test(d)).slice(0, MAX_CHIPS); } catch { return []; }
  const chips = [];
  for (const d of dirs) {
    const dir = `${root}/${d}`;
    const chip = (await readLabel(fsp, `${dir}/name`)).replace(/[^A-Za-z0-9_.+-]/g, '_').slice(0, 32);
    const real = await realDir(fsp, dir);
    if (!chip || !real) continue;
    let devKey = 'virtual';
    try { devKey = hwmonDevKey(await fsp.realpath(`${dir}/device`)); } catch { /* a virtual chip has no device */ }
    chips.push({ dir, real, chip, devKey, kind: hwmonKind(chip), fans: await fanIndexes(fsp, dir) });
  }
  return chips;
}

// The temperatures safety.js and the brain use, from the chips that carry them.
async function chipTemps(c, fsp, temps, power, at) {
  const put = (key, value) => { if (value != null && value > -20 && value < 130 && !temps[key]) temps[key] = { value, at }; };
  for (let i = 1; i <= 8; i += 1) {
    const value = celsius(await readLabel(fsp, `${c.dir}/temp${i}_input`));
    if (value == null) continue;
    const label = await readLabel(fsp, `${c.dir}/temp${i}_label`);
    if (c.kind === 'cpu' && (/Tctl|Tdie|Package/i.test(label) || i === 1)) put('cpu', value);
    else if (c.kind === 'gpu') put(/junction/i.test(label) ? 'gpuHot' : /mem/i.test(label) ? 'gpuMem' : 'gpu', value);
    else if (c.kind === 'cooler' && /coolant|liquid|water/i.test(label)) put('liquid', value);
  }
  if (c.kind === 'gpu' && power.gpu == null) {
    const uw = (await readNum(fsp, `${c.dir}/power1_average`)) ?? (await readNum(fsp, `${c.dir}/power1_input`));
    if (uw != null && uw >= 0) power.gpu = Math.round(uw / 1e5) / 10;
  }
}

const tachId = (c, i) => fanId('hwmon', `${c.chip}-${c.devKey}`, `fan${i}`);

// Every speed reading on a chip, under a control or not: the fan check pairs them.
async function chipTachs(c, fsp, tachs) {
  for (const i of c.fans) {
    const rpm = await readNum(fsp, `${c.dir}/fan${i}_input`);
    const id = tachId(c, i);
    if (id && rpm != null && rpm >= 0 && rpm <= 30000) tachs[id] = rpm;
  }
}

// One channel per pwmN, named like the Fans widget names fanN (same index), so its
// rename applies; fanN is also its speed until the check pairs the real one.
async function chipChannels(c, fsp, tachs) {
  const out = [];
  for (let i = 1; i <= MAX_PWM; i += 1) {
    const files = pwmFiles(c.dir, i);
    const raw = await readNum(fsp, files.pwm);
    if (raw == null || raw < 0 || raw > 255) continue;
    const enable = await readNum(fsp, files.enable);
    const label = await readLabel(fsp, `${c.dir}/fan${i}_label`);
    const name = label || `${c.chip} fan ${i}`;
    const tach = tachId(c, i);
    const gpu = c.kind === 'gpu';
    const canWrite = enable != null && (await writable(fsp, files.pwm)) && (await writable(fsp, files.enable));
    out.push({
      id: fanId('hwmon', `${c.chip}-${c.devKey}`, `pwm${i}`), files, raw, enable,
      name, labelKey: `${fanKind(c.chip)}|${name}`,
      source: gpu ? 'gpu' : c.kind === 'cooler' ? 'hub' : 'mb', controllable: canWrite,
      beta: !SUPER_IO_RE.test(c.chip),
      why: canWrite ? null : enable == null ? 'no-mode' : 'access',
      zeroByDefault: gpu, rpm: tachs[tach] ?? null, tach: tach in tachs ? tach : null,
      duty: toDuty(raw), min: 0, max: 100,
    });
  }
  return out.filter((ch) => ch.id);
}

/**
 * @param {{ root?: string, fsp?: typeof fs.promises, now?: () => number, bootIdFile?: string,
 *   saveHeld?: (o: object) => Promise<boolean>, loadHeld?: () => Promise<any>, watchdog?: any }} [opts]
 */
function createHwmonDriver({
  root = ROOT, fsp = fs.promises, now = Date.now, bootIdFile = BOOT_ID,
  saveHeld = async () => true, loadHeld = async () => null, watchdog = null,
} = {}) {
  let chips = null;
  let scannedAt = 0;
  let channels = [];
  /** id -> { files, raw, enable } as they were before Xenon took the channel. */
  const held = new Map();
  let boot = null;

  const bootId = async () => (boot = boot ?? ((await readLabel(fsp, bootIdFile)) || 'unknown'));
  const snapshot = async () => ({ boot: await bootId(), held: Object.fromEntries(held) });

  async function rescan() { chips = await listChips(root, fsp); scannedAt = now(); }

  async function poll() {
    if (!chips || now() - scannedAt > RESCAN_MS) await rescan();
    // A chip unplugged, or its number now another device's: walk again before reading.
    for (const c of chips) if ((await realDir(fsp, c.dir)) !== c.real) { await rescan(); break; }
    const at = now();
    const temps = {};
    const power = {};
    const found = [];
    /** @type {Record<string, number>} */
    const tachs = {};
    for (const c of chips) {
      await chipTemps(c, fsp, temps, power, at);
      await chipTachs(c, fsp, tachs);
      found.push(...(await chipChannels(c, fsp, tachs)));
    }
    // A held channel follows its chip to a new number: hand back where it is now.
    for (const ch of found) if (held.has(ch.id)) held.get(ch.id).files = ch.files;
    channels = found.map((ch) => ({ ...ch, held: held.has(ch.id) ? 'set' : null, restorable: true }));
    return {
      at, gen: 0, guard: null, hot: false, temps, power, tachs,
      rpm: Object.fromEntries(channels.map((c) => [c.id, c.rpm])),
      duty: Object.fromEntries(channels.map((c) => [c.id, c.duty])),
      held: Object.fromEntries(channels.map((c) => [c.id, c.held])),
    };
  }

  async function available() {
    if (!channels.length) await poll();
    if (!channels.length) return { ok: false, why: 'no-control' };
    if (!channels.some((c) => c.controllable)) {
      return { ok: false, why: channels.some((c) => c.why === 'access') ? 'access' : 'no-control' };
    }
    return { ok: true, why: null };
  }

  // Saved first, written after: a channel whose originals could not be kept is never touched.
  async function take(c) {
    if (held.has(c.id)) return true;
    held.set(c.id, { files: c.files, raw: c.raw, enable: c.enable });
    let saved = false;
    try { saved = (await saveHeld(await snapshot())) === true; } catch { saved = false; }
    if (!saved) { held.delete(c.id); return false; }
    watchdog?.hold(c.id, [[c.files.pwm, c.raw], [c.files.enable, c.enable]]);
    if (c.enable !== MANUAL) await fsp.writeFile(c.files.enable, String(MANUAL));
    return true;
  }

  // The originals back, value first then mode. If the mode will not go back the fan is
  // left at full speed: loud, never hot.
  async function giveBack(id) {
    const h = held.get(id);
    if (!h) return;
    // Each write on its own: the mode is what gives the chip its curve back, so a
    // value that will not go back must not stop it.
    try { await fsp.writeFile(h.files.pwm, String(h.raw)); } catch { /* the mode below matters more */ }
    try {
      await fsp.writeFile(h.files.enable, String(h.enable));
    } catch {
      await fsp.writeFile(h.files.pwm, '255').catch(() => {});
    }
    held.delete(id);
    watchdog?.free(id);
    try { await saveHeld(await snapshot()); } catch { /* the watchdog and the next start still know */ }
  }

  // One channel to its verdict; true when it ended where it was asked to be. A card's fan
  // set to 0 is handed back: only the card's own rest mode stops it, watching its heat.
  async function drive(c, v) {
    const back = !c.controllable || v?.action !== 'set' || !Number.isFinite(v.duty) || (c.zeroByDefault && v.duty <= 0);
    if (back) { await giveBack(c.id); return true; }
    try {
      if (!(await take(c))) return false;
      const raw = toRaw(/** @type {number} */ (v.duty));
      if (raw !== c.raw) { await fsp.writeFile(c.files.pwm, String(raw)); c.raw = raw; }
      return true;
    } catch {
      await giveBack(c.id);
      return false;
    }
  }

  /**
   * Drive: one verdict per channel id (safety.js check().channels). 'set' writes the
   * duty, anything else, or a channel left out, hands the fan back.
   * @param {Record<string, { action: string, duty?: number }>} verdicts
   * @returns {Promise<{ failed: string[] }>} the channels that could not be driven (back to the PC)
   */
  async function apply(verdicts) {
    const failed = [];
    for (const c of channels) if (!(await drive(c, verdicts?.[c.id]))) failed.push(c.id);
    // Held but no longer listed: the chip went away, nothing left to write.
    const listed = new Set(channels.map((c) => c.id));
    for (const id of [...held.keys()]) if (!listed.has(id)) { held.delete(id); watchdog?.free(id); }
    return { failed };
  }

  /** Every fan back, at the files where its chip is now. */
  async function release() {
    if (held.size) await poll();
    for (const id of [...held.keys()]) await giveBack(id);
  }

  /** A previous run that died in this same boot: put its originals back. Another boot reset them already. */
  async function clear() {
    let saved = null;
    try { saved = await loadHeld(); } catch { saved = null; }
    if (saved && saved.boot === (await bootId()) && saved.held && typeof saved.held === 'object') {
      for (const h of Object.values(saved.held)) {
        if (!isPwmFile(root, h?.files?.pwm) || !isPwmFile(root, h?.files?.enable)) continue;
        if (!Number.isInteger(h.raw) || h.raw < 0 || h.raw > 255 || !Number.isInteger(h.enable) || h.enable < 0 || h.enable > 9) continue;
        await fsp.writeFile(h.files.pwm, String(h.raw)).catch(() => {});
        await fsp.writeFile(h.files.enable, String(h.enable)).catch(() => {});
      }
    }
    if (saved) { try { await saveHeld(await snapshot()); } catch { /* tried again at the next take */ } }
  }

  const hello = async () => {};
  return { id: 'hwmon', available, poll, channels: () => channels, hello, apply, release, clear };
}

module.exports = { createHwmonDriver, isPwmFile, toRaw, toDuty, ROOT };
