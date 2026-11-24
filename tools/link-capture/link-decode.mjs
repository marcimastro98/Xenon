// What a program said to an iCUE LINK hub, from the reports of a capture (pcap.mjs): each
// report as a command in the hub's language (server/airflow/corsair-link-protocol.js), with
// the endpoint a write went to. Pure. Commands Xenon does not know yet are shown as bytes:
// finding them is what the capture is for.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../../server/airflow/corsair-link-protocol.js');

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
const HEX_SHOWN = 24;

// A command starts after 00 01; the report id is on the wire only for some programs.
function commandStart(d) {
  if (d.length > 2 && d[0] === 0x00 && d[1] === 0x01) return 2;
  if (d.length > 3 && d[0] === 0x00 && d[1] === 0x00 && d[2] === 0x01) return 3;
  return -1;
}

// The last byte that is not zero, so a 512-byte report shows only what it carries.
function used(d) {
  let end = d.length;
  while (end > 0 && d[end - 1] === 0) end -= 1;
  return d.subarray(0, end);
}

/**
 * One report sent to the hub, read as a command.
 * @param {Buffer} data the report as it went on the wire
 * @returns {{ name: string, ep?: number, type?: number[], payload?: Buffer, bytes: Buffer }}
 */
export function commandOf(data) {
  const at = commandStart(data);
  const c = at < 0 ? used(data) : used(data.subarray(at));
  const same = (want) => want.every((b, i) => c[i] === b);
  if (at < 0) return { name: 'unframed', bytes: c };
  if (same(P.COMMAND.software())) return { name: 'software', bytes: c };
  if (same(P.COMMAND.hardware())) return { name: 'hardware', bytes: c };
  if (same(P.COMMAND.firmware())) return { name: 'firmware', bytes: c };
  if (c[0] === 0x0d && c[1] === 0x01) return { name: 'open', ep: c[2], bytes: c };
  if (c[0] === 0x05 && c[1] === 0x01 && c[2] === 0x01) return { name: 'close', ep: c[3], bytes: c };
  if (c[0] === 0x08 && c[1] === 0x01) return { name: 'read', bytes: c };
  if (c[0] === 0x06 && c[1] === 0x01 && c.length >= 8) {
    const len = c[2] | (c[3] << 8);
    const full = data.subarray(at + 8, at + 8 + Math.max(0, len - 2));
    return { name: 'write', type: [c[6], c[7]], payload: full, bytes: c };
  }
  return { name: `op ${hex([c[0] ?? 0])}`, bytes: c };
}

/**
 * The hub's answer to a command: the command it echoes, its status and data type.
 * @param {Buffer} data
 */
export function answerOf(data) {
  const rep = P.reply(data);
  if (!rep) return { name: 'short answer', bytes: used(data) };
  return { name: `answer ${hex([rep.op])}`, status: rep.status, type: rep.type, bytes: used(data) };
}

/**
 * Every report as a line, the endpoint a write went to named, repeats folded into one.
 * @param {{ t: number, out: boolean, data: Buffer }[]} reports
 * @returns {string[]}
 */
export function timeline(reports, { answers = false } = {}) {
  const lines = [];
  let ep = null;
  let last = null;
  for (const r of reports) {
    if (!r.out && !answers) continue;
    const cmd = r.out ? commandOf(r.data) : answerOf(r.data);
    if (r.out && cmd.name === 'open') ep = cmd.ep;
    let text = `${r.out ? '>' : '<'} ${cmd.name}`;
    if (cmd.ep != null) text += ` ep ${hex([cmd.ep])}`;
    if (cmd.name === 'write') text += ` to ep ${ep == null ? '?' : hex([ep])} type ${hex(cmd.type)} (${cmd.payload.length} bytes) ${hex(cmd.payload.subarray(0, HEX_SHOWN))}`;
    else if (cmd.status != null) text += ` status ${cmd.status} type ${hex(cmd.type)}`;
    else if (!['software', 'hardware', 'firmware', 'open', 'close', 'read'].includes(cmd.name)) text += ` ${hex(cmd.bytes.subarray(0, HEX_SHOWN))}`;
    if (last && last.text === text) {
      last.count += 1;
      continue;
    }
    last = { t: r.t, text, count: 1 };
    lines.push(last);
  }
  return lines.map((l) => `${l.t.toFixed(3).padStart(9)}  ${l.text}${l.count > 1 ? `  x${l.count}` : ''}`);
}

/**
 * The writes grouped by endpoint and data type: how many, which lengths, and each distinct
 * payload once with when it was first sent. This is where colours show up.
 * @param {{ t: number, out: boolean, data: Buffer }[]} reports
 */
export function writes(reports) {
  const groups = new Map();
  let ep = null;
  for (const r of reports) {
    if (!r.out) continue;
    const cmd = commandOf(r.data);
    if (cmd.name === 'open') ep = cmd.ep;
    if (cmd.name !== 'write') continue;
    const key = `ep ${ep == null ? '?' : hex([ep])} type ${hex(cmd.type)}`;
    if (!groups.has(key)) groups.set(key, { key, count: 0, lengths: new Set(), payloads: new Map() });
    const g = groups.get(key);
    g.count += 1;
    g.lengths.add(cmd.payload.length);
    const id = cmd.payload.toString('hex');
    if (!g.payloads.has(id)) g.payloads.set(id, { t: r.t, payload: cmd.payload });
  }
  return [...groups.values()].map((g) => ({
    key: g.key, count: g.count, lengths: [...g.lengths], distinct: [...g.payloads.values()],
  }));
}

/** A payload's bytes as RGB triples, the same colour in a row folded: "ff0000 x34, 000000 x8". */
export function triples(payload) {
  const runs = [];
  for (let i = 0; i + 3 <= payload.length; i += 3) {
    const c = hex(payload.subarray(i, i + 3)).replace(/ /g, '');
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.c === c) lastRun.n += 1;
    else runs.push({ c, n: 1 });
  }
  const rest = payload.length % 3 ? ` +${payload.length % 3} bytes` : '';
  return runs.map((r) => (r.n > 1 ? `${r.c} x${r.n}` : r.c)).join(', ') + rest;
}
