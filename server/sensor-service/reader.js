'use strict';
// The engine's side of the sensor service (server/sensor-service.ps1, copied to
// "%ProgramFiles%\Xenon Sensors" and run elevated by the "Xenon Sensors" task;
// see enable-sensors.ps1). The engine itself never runs elevated, so the kernel
// sensors (CPU temperature, fans, CPU and PSU watts, CPU clock) come from the
// readings that service writes to "%ProgramData%\Xenon Sensors".
//
// The service reads only while asked: the engine rewrites
// %LOCALAPPDATA%\Xenon\sensor-want (its content is the refresh interval) each
// time it wants a reading, at most every few seconds. No dashboard looking, no
// touch, no hardware reads.
//
// When the service is not installed or not running (heartbeat older than a
// minute), every function answers null and the caller reads the sensors itself
// with the user's rights, exactly as before.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVICE_NAME = 'Xenon Sensors';
const SCRIPTS = ['sensor-service.ps1', 'cpu-temp.ps1', 'sensors.ps1'];
const ALIVE_MS = 60000;      // the service writes its heartbeat every 15 s
const FRESH_MS = 15000;      // a reading older than this is not shown as current
const STALE_OK_MS = 60000;   // ...but bridges the seconds the service takes to wake
const WANT_EVERY_MS = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// What cpu-temp.ps1 answers while the service is waking: nothing read yet, and
// no reason to offer the "Enable sensors" button.
const WAKING = Object.freeze({ cpuTemp: null, cpuTempSource: null, fans: [], cpuWatts: null, psuWatts: null, cpuClockMHz: null, sensorAccess: 'ok' });

function createSensorService({ env = process.env, serverDir = path.join(__dirname, '..'), platform = process.platform, now = Date.now, fsp = fs.promises } = {}) {
  const enabled = platform === 'win32' && !!env.LOCALAPPDATA;
  const readingsDir = path.join(env.ProgramData || 'C:\\ProgramData', SERVICE_NAME);
  const wantFile = enabled ? path.join(env.LOCALAPPDATA, 'Xenon', 'sensor-want') : null;
  let wantedAt = 0;
  let wantedRate = 0;
  let localHash;
  let lastCpu = null;

  async function readJson(leaf) {
    try {
      const file = path.join(readingsDir, leaf);
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      const o = JSON.parse(await fsp.readFile(file, 'utf8'));
      return o && typeof o === 'object' ? o : null;
    } catch { return null; }
  }

  async function heartbeat() {
    if (!enabled) return null;
    const beat = await readJson('service.json');
    if (!beat || beat.v !== 1 || !Number.isFinite(beat.at) || now() - beat.at > ALIVE_MS) return null;
    return beat;
  }

  async function scriptsHash() {
    if (localHash !== undefined) return localHash;
    try {
      const sha = crypto.createHash('sha256');
      for (const f of SCRIPTS) sha.update(await fsp.readFile(path.join(serverDir, f)));
      localHash = sha.digest('hex');
    } catch { localHash = null; }
    return localHash;
  }

  async function want(rateMs) {
    const rate = Math.min(10000, Math.max(1000, Math.round(Number(rateMs) || 5000)));
    if (now() - wantedAt < WANT_EVERY_MS && rate === wantedRate) return;
    wantedAt = now();
    wantedRate = rate;
    try {
      await fsp.mkdir(path.dirname(wantFile), { recursive: true });
      await fsp.writeFile(wantFile, String(rate));
    } catch { /* the service then idles, and the caller sees stale readings */ }
  }

  // A reading the service wrote, as long as it is recent: { data } or null.
  async function reading(leaf, maxAgeMs) {
    const o = await readJson(leaf);
    if (!o || !Number.isFinite(o.at) || now() - o.at > maxAgeMs || !o.data || typeof o.data !== 'object') return null;
    return o.data;
  }

  // cpu-temp.ps1's answer from the service, or null when the service is not there.
  async function cpu(rateMs) {
    if (!(await heartbeat())) return null;
    await want(rateMs);
    const data = await reading('cpu.json', FRESH_MS);
    if (data) { lastCpu = { data, at: now() }; return data; }
    if (lastCpu && now() - lastCpu.at < STALE_OK_MS) return lastCpu.data;
    return WAKING;
  }

  // The service's sensor rows merged into sensors.ps1's own answer (`raw`, which
  // still carries the GPU, read with the user's rights). The service wins on a
  // shared id. `ids` null = the whole list.
  async function mergeSensors(raw, ids) {
    if (!(await heartbeat())) return raw;
    const svc = await reading('sensors.json', FRESH_MS);
    if (!svc || svc.ok !== true) return raw;
    const pick = ids ? new Set(ids) : null;
    const rows = (Array.isArray(svc.sensors) ? svc.sensors : (svc.sensors ? [svc.sensors] : []))
      .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && (!pick || pick.has(r.id)));
    const base = raw && raw.ok === true ? raw : { ok: true, lhm: false, sensors: [] };
    const own = (Array.isArray(base.sensors) ? base.sensors : (base.sensors ? [base.sensors] : []));
    const seen = new Set(rows.map((r) => r.id));
    return { ok: true, lhm: base.lhm === true || svc.lhm === true, sensors: rows.concat(own.filter((r) => !(r && seen.has(r.id)))) };
  }

  // null = no service running; otherwise whether its scripts are older than
  // this engine's (an update changed them: one more prompt brings it level).
  async function state() {
    const beat = await heartbeat();
    if (!beat) return null;
    const mine = await scriptsHash();
    return { running: true, outdated: !!mine && typeof beat.hash === 'string' && beat.hash !== mine };
  }

  return { cpu, mergeSensors, state, readingsDir, wantFile };
}

// The one the engine uses: server.js reads through it, routes.js reports its state.
let shared = null;
const instance = () => (shared = shared || createSensorService());

module.exports = { createSensorService, instance, SERVICE_NAME, SCRIPTS };
