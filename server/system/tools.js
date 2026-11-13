// What the assistant does when asked about the PC: its readings now and over time, one sensor,
// the batteries of the devices, the power drawn, and where the sensors are read from.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const lighting = require('../lighting.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'guardian_report': async (_context, { guardian }) => {
      let fnResult;
      // Guardian (opt-in): deterministic local digest of the sensor history —
      // the model turns it into a human health report. Zero extra API calls.
      fnResult = await guardian.getDigest();
      return fnResult;
  },

  'query_sensor_history': async ({ fnArgs }, { guardian }) => {
      let fnResult;
      // Guardian (opt-in): targeted per-metric history so the model can compare
      // days / find peaks / read the trend. Deterministic, zero API cost.
      fnResult = await guardian.queryHistory(fnArgs.metric || '');
      return fnResult;
  },

  'get_system_info': async (_context, { getSystemInfo }) => {
      let fnResult;
      fnResult = await getSystemInfo();
      return fnResult;
  },

  'show_sensor': async ({ fnArgs }, { getSystemInfo }) => {
      let fnResult;
      const sys = await getSystemInfo().catch(() => null);
      // One flat metric map over the assembled system payload — the same
      // projections the Deck's live 'sensor' keys use.
      let value = null;
      if (sys) {
        const p = sys.power || {};
        const fans = Array.isArray(sys.fans) ? sys.fans : [];
        // Same discriminator + spinning-fan preference as the Deck's live
        // 'sensor' projection (deck-model.js sensorsFromSystem) — the AI and a
        // Deck key bound to the same metric must report the same fan.
        const gpuFan = fans.find(f => f && f.kind === 'gpu');
        const cpuFan = fans.find(f => f && f.kind !== 'gpu' && Number(f.rpm) > 0) || fans.find(f => f && f.kind !== 'gpu');
        const metrics = {
          cpuTemp: sys.cpuTemp, gpuTemp: sys.gpuTemp, cpu: sys.cpu, gpu: sys.gpu,
          cpuFan: cpuFan ? cpuFan.rpm : null,
          gpuFan: gpuFan ? (gpuFan.rpm != null ? gpuFan.rpm + ' RPM' : (gpuFan.pct != null ? gpuFan.pct + '%' : null)) : null,
          cpuWatts: p.cpu, gpuWatts: p.gpu, totalWatts: p.total, psuWatts: p.psu,
        };
        value = Object.prototype.hasOwnProperty.call(metrics, fnArgs.sensor) ? metrics[fnArgs.sensor] : null;
      }
      fnResult = { sensor: fnArgs.sensor, value, lightingAvailable: lighting.getStatus().available };
      return fnResult;
  },

  'get_battery_status': async (_context, { batteryMonitor }) => {
      let fnResult;
      const bat = await batteryMonitor.getDevices().catch(() => null);
      fnResult = bat
        ? { ...bat, devices: bat.devices.map(({ lastSeen, ...d }) => (lastSeen ? { ...d, lastReadMinutesAgo: Math.round((Date.now() - lastSeen) / 60000) } : d)) }
        : { devices: [], sources: { corsair: false, bluetooth: false, peripherals: false } };
      return fnResult;
  },

  'get_energy_status': async (_context, { buildHaState, getSystemInfo }) => {
      let fnResult;
      const sys = await getSystemInfo().catch(() => null);
      const ha = await buildHaState().catch(() => null);
      fnResult = {
        pc: (sys && sys.power) || { cpu: null, gpu: null, psu: null, total: null },
        home: (ha && Array.isArray(ha.energy)) ? ha.energy.map(e => ({ name: e.name, value: e.state, unit: e.unit || '', deviceClass: e.deviceClass || '' })) : [],
        homeConfigured: !!(ha && ha.configured),
      };
      return fnResult;
  },

  'sensor_source': async ({ fnArgs }, { chooseSensorSource }) => {
      let fnResult;
      fnResult = await chooseSensorSource(fnArgs);
      return fnResult;
  },
};

module.exports = { branches };
