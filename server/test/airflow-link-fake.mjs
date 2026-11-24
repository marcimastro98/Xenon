// A stand-in iCUE LINK hub for the tests: it speaks the protocol of
// server/airflow/corsair-link-protocol.js on a report link (write/read/close), with the
// state a real hub keeps: its mode, the open endpoints, the speeds it was given, the colour
// frames it was sent on its colour handle (0, endpoint 0x22). Device ids are invented.

const TYPE = { devices: [0x21, 0x00], speeds: [0x25, 0x00], temps: [0x10, 0x00], cont: [0x00, 0x00] };

/** One channel of the device list: 8-byte header (type at 2, model at 3, id length at 7), then the id. */
export function deviceEntry(type, model, id) {
  const head = [0, 0, type, model, 0, 0, 0, id.length];
  return [...head, ...Buffer.from(id, 'ascii')];
}
export const EMPTY = [0, 0, 0, 0, 0, 0, 0, 0];

/** Readings data: a count, then status + int16 LE per channel (null = no value). */
export function readingsData(values) {
  const out = [values.length];
  for (const v of values) {
    if (v == null) out.push(0x01, 0, 0);
    else out.push(0x00, v & 0xff, (v >> 8) & 0xff);
  }
  return out;
}

/**
 * @param {{ channels?: number[][], firmware?: number[], rpm?: (number|null)[], temps?: (number|null)[],
 *   leadingZero?: boolean, silentAfter?: number, leaseMs?: number }} [o]
 *   channels: device list entries from channel 1. A list longer than one reply's 506 data
 *   bytes goes on in a second read, as on a real hub with a long chain. leaseMs: after this
 *   long without a command (hub.clock, moved by the test) the hub is back in hardware mode.
 */
export function fakeLinkHub(o = {}) {
  const channels = o.channels ?? [deviceEntry(0x07, 0x02, 'AIOPUMP00000001'), deviceEntry(0x01, 0x00, 'QXFAN0000000001'), EMPTY];
  const list = [channels.length, ...channels.flat()];
  const split = 506;
  const hub = {
    mode: 'hardware', open: null, colours: null, frames: [], reads: 0, log: [], speeds: new Map(), queue: [], stale: [], silent: false, clock: 0, lastAt: 0,
    firmware: o.firmware ?? [3, 11, 646], rpm: o.rpm ?? [null, 2400, 900], temps: o.temps ?? [null, 312, 290],
  };
  const answer = (op, status, type = [0, 0], data = []) => {
    const raw = Buffer.alloc(512);
    raw[2] = op; raw[3] = status; raw[4] = type[0]; raw[5] = type[1];
    Buffer.from(data).copy(raw, 6);
    hub.queue.push(o.leadingZero === false ? raw : Buffer.concat([Buffer.from([0]), raw]));
  };
  function onRead(op) {
    const sw = hub.mode === 'software';
    if (!sw) return answer(op, 0x03);
    hub.reads++;
    if (hub.open === 0x36) {
      if (hub.reads === 1) return answer(op, 0, TYPE.devices, list.slice(0, split));
      // The second read: its data starts 4 bytes in, so it is placed at [4] of the reply.
      const raw = Buffer.alloc(512);
      raw[2] = op;
      Buffer.from(list.slice(split)).copy(raw, 4);
      return hub.queue.push(o.leadingZero === false ? raw : Buffer.concat([Buffer.from([0]), raw]));
    }
    if (hub.open === 0x17) return answer(op, 0, TYPE.speeds, readingsData(hub.rpm));
    if (hub.open === 0x21) return answer(op, 0, TYPE.temps, readingsData(hub.temps));
    return answer(op, 0x01);
  }
  function onWrite(cmd) {
    const op = cmd[0];
    if (hub.silent) return;
    if (op === 0x01) { hub.mode = cmd[3] === 0x02 ? 'software' : 'hardware'; hub.colours = null; return answer(op, 0); }
    if (op === 0x0d && cmd[1] === 0x00) {
      if (hub.mode !== 'software') return answer(op, 0x03);
      hub.colours = cmd[2];
      return answer(op, 0);
    }
    if (op === 0x05 && cmd[2] === 0x00) { const was = hub.colours != null; hub.colours = null; return answer(op, was ? 0 : 0x01); }
    if (op === 0x06 && cmd[1] === 0x00) {
      if (hub.mode !== 'software' || hub.colours !== 0x22 || cmd[6] !== 0x12 || cmd[7] !== 0x00) return answer(op, 0x03);
      hub.frames.push([...cmd.subarray(8, 8 + (cmd[2] | (cmd[3] << 8)) - 2)]);
      return answer(op, 0);
    }
    if (op === 0x02) return answer(op, 0, [hub.firmware[0], hub.firmware[1]], [hub.firmware[2] & 0xff, hub.firmware[2] >> 8]);
    if (op === 0x0d) {
      if (hub.mode !== 'software') return answer(op, 0x03);
      hub.open = cmd[2]; hub.reads = 0;
      return answer(op, 0);
    }
    if (op === 0x05) { const was = hub.open === cmd[3]; hub.open = was ? null : hub.open; return answer(op, was ? 0 : 0x01); }
    if (op === 0x08) return onRead(op);
    if (op === 0x06) {
      if (hub.mode !== 'software' || hub.open !== 0x18) return answer(op, 0x03);
      const data = cmd.subarray(8);
      for (let i = 0; i < data[0]; i++) hub.speeds.set(data[1 + i * 4], data[3 + i * 4] | (data[4 + i * 4] << 8));
      return answer(op, 0);
    }
    return answer(op, 0x01);
  }
  hub.link = {
    async write(buf) {
      if (buf.length !== 513 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 0x01) throw new Error('bad report');
      const cmd = buf.subarray(3);
      if (o.leaseMs != null && hub.clock - hub.lastAt >= o.leaseMs) { hub.mode = 'hardware'; hub.open = null; hub.colours = null; }
      hub.lastAt = hub.clock;
      hub.log.push([...cmd.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
      onWrite(cmd);
      if (hub.log.length === o.silentAfter) hub.silent = true;
    },
    async read() {
      if (hub.stale.length) return hub.stale.shift();
      return hub.queue.shift() ?? null;
    },
    async close() { hub.closed = true; },
  };
  return hub;
}
