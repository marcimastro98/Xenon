'use strict';
// One conversation with an iCUE LINK hub (language: corsair-link-protocol.js). The hub
// answers each command with one report and has no sequence numbers, so commands go one
// at a time, stale reports are drained before each, and a reply counts only if it
// echoes the command (and, for a read, carries the data type asked for). A hub that
// left software mode (it does so by itself after some seconds of silence, or after a
// replug) answers "wrong mode": the session enters software mode again and retries once.
// The colours keep their own handle open (corsair-link-protocol.js); entering software mode
// again closes it, so the next frame opens it first.

const P = require('./corsair-link-protocol.js');

const REPLY_MS = 500;
const DRAIN_MAX = 16;

class LinkError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {{
 *   link: { write(b: Buffer): Promise<void>, read(ms: number): Promise<Buffer|null>, close(): Promise<void> },
 *   leadingZero: boolean,
 *   now?: () => number,
 * }} opts link: an open report link to interface 0; leadingZero: its reads carry the report id first
 */
function createLinkSession({ link, leadingZero, now = Date.now }) {
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const strip = (r) => (leadingZero ? r.subarray(1) : r);

  async function drain() {
    for (let i = 0; i < DRAIN_MAX; i++) if (!(await link.read(1))) return;
  }

  async function send(cmd, type = null) {
    await drain();
    await link.write(P.packet(cmd));
    const until = now() + REPLY_MS;
    while (now() < until) {
      const got = await link.read(Math.max(1, until - now()));
      if (!got) continue;
      const raw = strip(got);
      const rep = P.reply(raw);
      if (!rep || rep.op !== cmd[0]) continue;
      if (type && rep.status === P.STATUS.ok && !P.sameType(rep.type, type)) continue;
      return { ...rep, raw };
    }
    throw new LinkError('the hub did not answer', 'timeout');
  }

  function done(rep, what) {
    if (rep.status === P.STATUS.wrongMode) throw new LinkError(`${what}: the hub is not in software mode`, 'mode');
    if (rep.status !== P.STATUS.ok) throw new LinkError(`${what}: the hub answered ${rep.status}`, 'status');
    return rep;
  }

  let coloursOpen = false;
  const software = async () => {
    coloursOpen = false;
    return done(await send(P.COMMAND.software()), 'software mode');
  };
  async function openColours() {
    await send(P.COMMAND.closeColours());
    done(await send(P.COMMAND.openColours()), 'open colours');
    // An empty frame first, as iCUE sends one before its first colours.
    done(await send(P.COMMAND.colours([])), 'colours');
    coloursOpen = true;
  }

  // A closed endpoint may refuse the first close: only an open that fails counts.
  async function endpoint(ep, act) {
    await send(P.COMMAND.close(ep));
    done(await send(P.COMMAND.open(ep)), 'open');
    try {
      return await act();
    } finally {
      await send(P.COMMAND.close(ep)).catch(() => {});
    }
  }

  // A hub found back in hardware mode is taken again once, and counted (retakes).
  let retakes = 0;
  async function inMode(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e.code !== 'mode') throw e;
      retakes++;
      await software();
      return fn();
    }
  }

  const read = (ep, type, more = false) => inMode(() => endpoint(ep, async () => {
    const first = done(await send(P.COMMAND.read(), type), 'read');
    const rest = more ? await send(P.COMMAND.read()) : null;
    return { first: first.raw, rest: rest ? rest.raw : null };
  }));

  return {
    /** The hub's firmware, answered in either mode. */
    firmware: () => serial(async () => P.firmwareOf(done(await send(P.COMMAND.firmware()), 'firmware').raw)),
    software: () => serial(software),
    /** How many times a command found the hub back in hardware mode. */
    retakes: () => retakes,
    /** 'software' or 'hardware', without changing it (an endpoint that opens means software mode). */
    mode: () => serial(async () => {
      const rep = await send(P.COMMAND.open(P.ENDPOINT.speeds));
      if (rep.status === P.STATUS.wrongMode) return 'hardware';
      await send(P.COMMAND.close(P.ENDPOINT.speeds)).catch(() => {});
      return 'software';
    }),
    /** Back to what the hub runs on its own (the profile iCUE saved in it). */
    hardware: () => serial(async () => done(await send(P.COMMAND.hardware()), 'hardware mode')),
    /** @param {boolean} more newer firmware sends the list in two reads */
    devices: (more) => serial(async () => {
      const r = await read(P.ENDPOINT.devices, P.DATA.devices, more);
      return P.parseDevices(r.first, r.rest);
    }),
    speeds: () => serial(async () => P.parseReadings((await read(P.ENDPOINT.speeds, P.DATA.speeds)).first, 1)),
    temps: () => serial(async () => P.parseReadings((await read(P.ENDPOINT.temps, P.DATA.temps)).first, 10)),
    /** @param {{ channel: number, percent: number }[]} entries */
    setSpeeds: (entries) => serial(() => inMode(() => endpoint(P.ENDPOINT.setSpeeds, async () => {
      done(await send(P.COMMAND.write(P.DATA.setSpeeds, P.speedData(entries))), 'speeds');
    }))),
    /** @param {number[]} data a whole frame (P.colourData) */
    paint: (data) => serial(() => inMode(async () => {
      if (!coloursOpen) await openColours();
      done(await send(P.COMMAND.colours(data)), 'colours');
    })),
    /** Whether the colour handle is still open: false after the hub was found back in hardware mode. */
    coloursOpen: () => coloursOpen,
    close: () => serial(() => link.close()),
  };
}

module.exports = { createLinkSession, LinkError, REPLY_MS };
