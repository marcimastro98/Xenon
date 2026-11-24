// The probe of an iCUE LINK hub, apart from the USB so the tests can run it on
// a stand-in hub (server/test/airflow-link-probe.test.mjs). It takes the hub into
// software mode, lists the chain, reads speeds and temperatures for a while, and always
// gives the hub back to hardware mode. If a pump's speed falls below half of its first
// reading it stops at once. Only with drive: it also sets the FANS (never a pump) to a
// few speeds, then measures after how many seconds of silence the hub goes back to its
// own profile (its lease). With watchMode it asks the hub's mode before every reading and
// counts the times another program put it back in hardware mode (out.flips). With colours
// it paints a few frames on the chain's lights (link-probe-colours.mjs, out.colours).

import { createRequire } from 'node:module';
import { paintSteps } from './link-probe-colours.mjs';

const require = createRequire(import.meta.url);
const { createLinkSession } = require('../../server/airflow/corsair-link-session.js');
const { linkDevice } = require('../../server/airflow/corsair-link-devices.js');

const PUMP_DROP = 0.5;
const DRIVE_STEPS = Object.freeze([30, 70]);
const STEP_READS = 6;
const SILENCES_S = Object.freeze([5, 10, 15, 20, 30]);

/** Newer firmware sends the device list in two reads. */
export const listInTwoReads = (fw) => !!fw && (fw.major > 2 || (fw.major === 2 && fw.minor >= 5));

/** A pump whose speed fell under half its first reading, or null. */
export function pumpDrop(first, now, pumps) {
  for (const ch of pumps) {
    const a = first.get(ch);
    const b = now.get(ch);
    if (a > 0 && !(b >= a * PUMP_DROP)) return { channel: ch, first: a, now: b ?? null };
  }
  return null;
}

// Every fan at each step for a few readings, the pumps left as they run.
async function driveSteps({ s, fans, pumps, log, sleep }) {
  const steps = [];
  let first = null;
  for (const percent of DRIVE_STEPS) {
    await s.setSpeeds(fans.map((channel) => ({ channel, percent })));
    let rpm = new Map();
    for (let i = 0; i < STEP_READS; i++) {
      await sleep(1000);
      rpm = await s.speeds();
      first = first || rpm;
      const drop = pumpDrop(first, rpm, pumps);
      if (drop) return { steps, stopped: drop };
    }
    steps.push({ percent, rpm: Object.fromEntries(rpm) });
    log(`fans at ${percent} %: ${fans.map((c) => `${c}:${rpm.get(c)}`).join(' ')}`);
  }
  return { steps, stopped: null };
}

// Seconds of silence after which the hub was found back in hardware mode, or null.
async function leaseOf({ s, fans, log, sleep }) {
  for (const n of SILENCES_S) {
    await s.software();
    await s.setSpeeds(fans.map((channel) => ({ channel, percent: DRIVE_STEPS[0] })));
    await sleep(n * 1000);
    const mode = await s.mode();
    log(`after ${n} s of silence: ${mode} mode`);
    if (mode === 'hardware') return n;
  }
  return null;
}

/**
 * @param {{ link: object, leadingZero: boolean, seconds: number, log: (s: string) => void,
 *   sleep: (ms: number) => Promise<void>, now?: () => number, drive?: boolean, watchMode?: boolean, colours?: boolean }} o
 */
export async function runProbe({ link, leadingZero, seconds, log, sleep, now, drive = false, watchMode = false, colours = false }) {
  const s = createLinkSession({ link, leadingZero, now });
  const out = { firmware: null, devices: [], samples: [], stopped: null, steps: [], lease: null, flips: 0, colours: null, backToHardware: false, error: null };
  try {
    out.firmware = await s.firmware();
    log(`firmware ${out.firmware ? out.firmware.text : '?'}`);
    await s.software();
    log('software mode');
    const devices = await s.devices(listInTwoReads(out.firmware));
    out.devices = devices.map((d) => ({ channel: d.channel, type: d.type, model: d.model, ...linkDevice(d.type, d.model) }));
    for (const d of out.devices) log(`channel ${d.channel}: ${d.name} (type ${d.type}, model ${d.model}, ${d.kind})`);
    const pumps = out.devices.filter((d) => d.kind === 'pump').map((d) => d.channel);
    let first = null;
    for (let i = 0; i < seconds; i++) {
      if (watchMode && (await s.mode()) === 'hardware') {
        out.flips++;
        log('the hub was back in hardware mode: another program talks to it');
        await s.software();
      }
      const rpm = await s.speeds();
      const temps = await s.temps();
      out.samples.push({ rpm: Object.fromEntries(rpm), temps: Object.fromEntries(temps) });
      log(`rpm ${[...rpm].map(([c, v]) => `${c}:${v}`).join(' ')} | °C ${[...temps].map(([c, v]) => `${c}:${v}`).join(' ')}`);
      first = first || rpm;
      const drop = pumpDrop(first, rpm, pumps);
      if (drop) {
        out.stopped = drop;
        log(`pump on channel ${drop.channel} fell from ${drop.first} to ${drop.now}: stopping`);
        break;
      }
      await sleep(1000);
    }
    if (colours && !out.stopped) {
      const stop = async () => {
        out.stopped = pumpDrop(first, await s.speeds(), pumps);
        return !!out.stopped;
      };
      out.colours = await paintSteps({ s, chain: devices, log, sleep, stop });
    }
    const fans = out.devices.filter((d) => d.kind === 'fan').map((d) => d.channel);
    if (drive && !out.stopped && fans.length) {
      const d = await driveSteps({ s, fans, pumps, log, sleep });
      out.steps = d.steps;
      out.stopped = d.stopped;
      if (!out.stopped) out.lease = await leaseOf({ s, fans, log, sleep });
    }
  } catch (e) {
    out.error = `${e.code || 'error'}: ${e.message}`;
    log(`error ${out.error}`);
  } finally {
    try {
      await s.hardware();
      out.backToHardware = true;
      log('hardware mode');
    } catch (e) {
      log(`could not go back to hardware mode (${e.message}); the hub goes back by itself after some seconds of silence`);
    }
    await s.close().catch(() => {});
  }
  return out;
}
