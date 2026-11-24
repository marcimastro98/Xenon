'use strict';
// Airflow's driver for Windows: motherboard headers, graphics cards and the USB coolers
// LibreHardwareMonitor drives (NZXT Kraken and Grid, MSI CoreLiquid, ARCTIC and Razer
// controllers). It is the engine's side of the hands inside the SYSTEM sensor service
// (server/fan-hands.ps1). An AMD card's control and a cooler's are beta: Xenon never
// tried them on real hardware, so they drive a fan only once the fan check saw it go
// back to the PC (calibrate-back.js). The
// engine never touches a fan itself. It reads what the service publishes
// (fan.json: controls, fan speeds, temperatures) and asks only through the NAME of
// an empty file in "%ProgramData%\Xenon Sensors\fan":
//   fan-<gen>-<seq>[-c<k>_<duty> ...]
// one a second while it drives; a control left out goes back to the firmware, and
// when the names stop for five seconds the service hands every fan back on its own.
// While Airflow only watches (shadow mode, discovery) it sends a hello, gen 0, which
// keeps the service reading and moves nothing. Each name is deleted once a newer one
// is there. Every file call goes through fan-files.js: the commands on a thread of their
// own, since libuv's shared pool can be full for a minute on a busy PC and a command must
// never wait on it.
const path = require('path');
const { fanId } = require('./inventory.js');
const sensorService = require('../sensor-service/reader.js');
const { LATE_OK_MS } = require('./limits.js');
const { within } = require('./within.js');
const { createFanFiles } = require('./fan-files.js');

// fan.json older than this is no reading (the service writes it every second).
const FRESH_MS = 5000;
// How long a tick waits for fan.json. Windows Defender scans every new fan.json before the
// engine may open it, and on a PC busy on every core that took up to 2.5 s (23 Nov 2026):
// past this the tick goes on with the last answer, so the commands keep coming every
// second, and the read is taken up when it lands.
const READ_WAIT_MS = 250;
// The grammar fan-hands.ps1 accepts.
const NAME_RE = /^fan-\d{1,15}-\d{1,15}(?:-c\d{1,2}_(?:\d{1,3}|d)){0,32}$/;
// Windows file names stop at 255; past this the extra controls are left out (back to the firmware).
const MAX_NAME = 240;
const MAX_CONTROLS = 32;
const MAX_FANS = 64;
const TEMP_KEYS = ['cpu', 'gpu', 'gpuHot', 'gpuMem', 'liquid', 'board'];
// The readings the service guards on its own, fresh, taking the fans when one gets hot
// (fan-hands.ps1 Get-FanHotLimits; a test keeps them equal). A late one of these keeps
// the fans at their last speed for a while (limits.js LATE_OK_MS).
const GUARDED_TEMPS = Object.freeze(['cpu', 'gpu', 'gpuHot', 'gpuMem']);
const LHM_ID_RE = /^\/[A-Za-z0-9_/-]{1,120}$/;
const TYPES = Object.freeze(['mb', 'gpu', 'ctrl']);
// A USB cooler whose fans sit on a radiator (an AIO's own controller).
const AIO_RE = /kraken|liquid/i;
const USB_CHIP_RE = /^usbhid\/([0-9A-Fa-f]{4})\/([0-9A-Fa-f]{4})\/[^/]+$/;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** '/lpc/it8689e/0/control/2' -> { chip: 'lpc/it8689e/0', index: '2' }; null when it has another shape. */
function splitLhmId(id, kind) {
  const parts = id.split('/').filter(Boolean);
  if (parts.length < 3 || parts.at(-2) !== kind || !/^\d{1,3}$/.test(parts.at(-1))) return null;
  return { chip: parts.slice(0, -2).join('/'), index: parts.at(-1) };
}

// fan.json's data as the service wrote it, checked field by field; null when unusable.
function parseStatus(data) {
  if (data?.v !== 1 || !finite(data.gen) || !finite(data.at) || !Array.isArray(data.controls)) return null;
  const at = data.at;
  const controls = [];
  for (const c of data.controls.slice(0, MAX_CONTROLS)) {
    const k = int(c?.k, 0, MAX_CONTROLS - 1);
    const min = int(c?.min, 0, 100);
    const max = int(c?.max, 0, 100);
    if (k == null || typeof c.id !== 'string' || !LHM_ID_RE.test(c.id) || !splitLhmId(c.id, 'control')) continue;
    if (min == null || max == null || min > max || !TYPES.includes(c.type)) continue;
    controls.push({
      // gpu: the card's maker (a service from before AMD controls sends none: NVIDIA only).
      k, lhmId: c.id, type: c.type, gpu: c.gpu === 'amd' ? 'amd' : 'nvidia', min, max,
      name: text(c.name, 48) || 'Fan', hw: text(c.hw, 64) || '',
      value: finite(c.value) ? c.value : null,
      held: ['set', 'hot', 'curve'].includes(c.held) ? c.held : null,
      duty: finite(c.duty) ? c.duty : null,
      restorable: c.restorable !== false,
    });
  }
  const fans = new Map();
  for (const f of (Array.isArray(data.fans) ? data.fans : []).slice(0, MAX_FANS)) {
    if (typeof f?.id === 'string' && LHM_ID_RE.test(f.id) && finite(f.rpm) && f.rpm >= 0 && f.rpm <= 20000) {
      fans.set(f.id, { name: text(f.name, 48) || 'Fan', rpm: f.rpm });
    }
  }
  const temps = {};
  for (const key of TEMP_KEYS) {
    if (finite(data.temps?.[key])) temps[key] = { value: data.temps[key], at, ...(GUARDED_TEMPS.includes(key) ? { guarded: true } : {}) };
  }
  const power = {};
  for (const key of ['cpu', 'gpu']) if (finite(data.power?.[key]) && data.power[key] >= 0) power[key] = data.power[key];
  return {
    at, gen: data.gen, controls, fans, temps, power,
    guard: ['hot', 'lease', 'sensor'].includes(data.guard) ? data.guard : null,
    hot: data.hot === true,
    lhm: data.lhm !== false,
  };
}

// A USB cooler's LHM id carries its serial number ('/usbhid/1E71/2007/<serial>/control/0').
// Fan ids reach the menu, Bit and widgets, so the serial stays out: devices of one model
// are told apart by their order instead, sorted so it holds while the same ones are
// plugged in. A USB id of another shape (a device path, which names the port) is never used.
function usbAliases(lhmIds) {
  const alias = new Map();
  const count = new Map();
  const chips = lhmIds.map((id) => id.split('/').filter(Boolean).slice(0, -2).join('/'));
  for (const chip of [...new Set(chips)].sort()) {
    const m = USB_CHIP_RE.exec(chip);
    if (!m) continue;
    const model = `usbhid/${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
    const n = count.get(model) ?? 0;
    count.set(model, n + 1);
    alias.set(chip, `${model}/${n}`);
  }
  return (chip) => alias.get(chip) ?? (chip.startsWith('usbhid/') ? null : chip);
}

// A fan speed reading's id: '/lpc/it8689e/0/fan/2' -> 'lhm:lpc-it8689e-0:fan-2'.
function tachId(lhmId, chipOf) {
  const p = splitLhmId(lhmId, 'fan');
  const chip = p && chipOf(p.chip);
  return chip ? fanId('lhm', chip, `fan-${p.index}`) : null;
}

// One channel per control, named after the fan on the same header (the name the
// Fans widget shows and renames); the check confirms the pairing later.
function channelOf(c, fans, chipOf) {
  const { chip, index } = /** @type {{ chip: string, index: string }} */ (splitLhmId(c.lhmId, 'control'));
  const shown = chipOf(chip);
  const id = shown && fanId('lhm', shown, `control-${index}`);
  if (!id) return null;
  const fanKey = `/${chip}/fan/${index}`;
  const fan = fans.get(fanKey);
  const name = fan?.name || c.name;
  const hub = c.type === 'ctrl';
  return {
    // labelKey: the Fans widget's kinds ('mb', 'gpu', 'ctrl' for a cooler), whose renames apply.
    id, k: c.k, name, labelKey: `${c.type}|${name}`,
    source: hub ? 'hub' : c.type, controllable: true,
    beta: hub || (c.type === 'gpu' && c.gpu === 'amd'),
    ...(hub && AIO_RE.test(c.hw) ? { place: 'radiator' } : {}),
    // A graphics card stops its own fans when cool: handing it back is how it stops.
    zeroByDefault: c.type === 'gpu',
    rpm: fan ? fan.rpm : null, tach: fan ? tachId(fanKey, chipOf) : null,
    duty: c.held ? c.duty : c.value,
    held: c.held, restorable: c.restorable, min: c.min, max: c.max,
  };
}

/**
 * @param {{ service?: any, files?: ReturnType<typeof createFanFiles>, now?: () => number, readWaitMs?: number }} [opts]
 */
function createLhmDriver({ service = sensorService.instance(), files = createFanFiles(), now = Date.now, readWaitMs = READ_WAIT_MS } = {}) {
  const fanDir = path.join(service.readingsDir, 'fan');
  const fanJson = path.join(service.readingsDir, 'fan.json');
  let status = null;
  /** @type {Promise<void> | null} */
  let reading = null;
  let channels = [];
  let lastName = null;
  let seq = 0;

  /** Whether the service can take fan commands on this PC, and if not, why. */
  async function available() {
    const st = await service.state();
    if (!st) return { ok: false, why: 'no-service' };
    // A service from before Airflow has no hands and no fan folder: one prompt updates it.
    if (st.outdated) return { ok: false, why: 'outdated' };
    try {
      if (!(await files.stat(fanDir)).dir) return { ok: false, why: 'outdated' };
    } catch { return { ok: false, why: 'outdated' }; }
    return { ok: true, why: null };
  }

  // One read at a time: a slow one is never stacked on, and lands whenever it is done.
  function read() {
    reading ??= files.readJson(fanJson)
      .then((o) => { const fresh = parseStatus(sensorService.freshData(o, FRESH_MS, now())); if (fresh) status = fresh; }, () => {})
      .finally(() => { reading = null; });
    return reading;
  }

  // Past FRESH_MS the last answer stands in only while the service still writes fan.json,
  // and never past LATE_OK_MS. The time on disk is read without opening the file, which
  // is what the antivirus holds: the service is alive and guards the heat itself.
  async function stillWriting(last) {
    if (now() - last.at > LATE_OK_MS) return false;
    try { return now() - (await files.stat(fanJson)).mtimeMs <= FRESH_MS; } catch { return false; }
  }

  /** The service's latest answer, or null while it is not (yet) answering. */
  async function poll() {
    // The service replaces fan.json every second and a read can land on the swap (about
    // 1 in 200 on a real PC, 22 Nov 2026), or wait on the antivirus (READ_WAIT_MS). The
    // last answer stands in, with its own time, so the safety layer still sees it age.
    await within(read(), readWaitMs);
    if (status && now() - status.at > FRESH_MS && !(await stillWriting(status))) status = null;
    const chipOf = usbAliases(status ? [...status.controls.map((c) => c.lhmId), ...status.fans.keys()] : []);
    channels = status ? status.controls.map((c) => channelOf(c, status.fans, chipOf)).filter(Boolean) : [];
    return status && {
      at: status.at, gen: status.gen, guard: status.guard, hot: status.hot, lhm: status.lhm,
      temps: status.temps, power: status.power,
      tachs: Object.fromEntries([...status.fans].map(([lhmId, f]) => [tachId(lhmId, chipOf), f.rpm]).filter(([id]) => id)),
      rpm: Object.fromEntries(channels.map((c) => [c.id, c.rpm])),
      duty: Object.fromEntries(channels.map((c) => [c.id, c.duty])),
      held: Object.fromEntries(channels.map((c) => [c.id, c.held])),
    };
  }

  async function sendName(name) {
    await files.create(path.join(fanDir, name));
    const old = lastName;
    lastName = name;
    if (old && old !== name) await files.unlink(path.join(fanDir, old)).catch(() => {});
  }

  const nextSeq = () => (seq = Math.max(now(), seq + 1));

  /** Keeps the service reading without moving anything. */
  const hello = () => sendName(`fan-0-${nextSeq()}`);

  /**
   * Drive: one verdict per channel id (safety.js check().channels). 'set' sends the
   * duty, anything else, or a channel left out, hands the fan back. A card's fan set
   * to 0 is handed back too: its control stops at its minimum (30 % on an RTX 5080,
   * where the service clamps), and only the card's own rest mode stops it.
   * @param {Record<string, { action: string, duty?: number }>} verdicts
   */
  async function apply(verdicts) {
    if (!status) return hello();
    let name = `fan-${status.gen}-${nextSeq()}`;
    for (const c of channels) {
      const v = verdicts?.[c.id];
      if (v?.action !== 'set' || !Number.isFinite(v.duty) || (c.zeroByDefault && v.duty <= 0)) continue;
      const part = `-c${c.k}_${Math.min(100, Math.max(0, Math.round(/** @type {number} */ (v.duty))))}`;
      if (name.length + part.length > MAX_NAME) break;
      name += part;
    }
    return sendName(name);
  }

  /** Every fan back to the firmware at once (no need to wait for the lease). */
  async function release() {
    if (status) await sendName(`fan-${status.gen}-${nextSeq()}`);
  }

  /** Names a previous run left behind. Only names of this grammar, only ours to delete. */
  async function clear() {
    let names = [];
    try { names = await files.list(fanDir); } catch { return; }
    await Promise.all(names.filter((n) => NAME_RE.test(n)).map((n) => files.unlink(path.join(fanDir, n)).catch(() => {})));
    lastName = null;
  }

  /** Server shutdown, after the fans were handed back: the file threads stop. */
  const close = () => files.close();

  return { id: 'lhm', available, poll, channels: () => channels, hello, apply, release, clear, close, fanDir };
}

module.exports = { createLhmDriver, parseStatus, splitLhmId, usbAliases, NAME_RE, FRESH_MS, READ_WAIT_MS, MAX_NAME, GUARDED_TEMPS };
