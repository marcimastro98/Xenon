#!/usr/bin/env node
// Reads what a VM run left behind (the chip's log, the phase marks, the server's log)
// and says, one line per promise, whether Linux keeps it. Exit code 1 on any failure.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../../server/lighting-native/fusion2-protocol.js');
const { gdbusParser, dbusMonitorParser } = require('../../server/linux-session-watch.js');

const dir = process.argv[2];
const file = (name) => path.join(dir, name);
const text = (name) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '');
const lines = (name) => text(name).split('\n').filter(Boolean);
const json = (name) => { try { return JSON.parse(text(name)); } catch { return {}; } };

const FORBIDDEN = [0x5E, 0x33, 0x47];
const REGS = P.HEADERS.map(h => h.reg);
const FEATURE_REPORT = 0;

const entries = lines('chip.jsonl').map(l => JSON.parse(l));
const sent = entries.filter(e => e.set).map(e => ({ ...e, bytes: Buffer.from(e.set, 'hex') }));
const marks = Object.fromEntries(lines('marks.jsonl').map(l => JSON.parse(l)).map(m => [m.mark, m.t]));
const between = (from, to) => sent.filter(e => e.t >= (marks[from] ?? Infinity) && e.t < (to ? marks[to] ?? Infinity : Infinity));

const handedBack = (list) => list.some(e => e.bytes[1] === P.CMD.EFFECTS_OFF && e.bytes[2] === 0);
const isStrip = (e) => REGS.includes(e.bytes[1]);
const stripData = (e) => e.bytes.subarray(5, 5 + e.bytes[4]);
const isRed = (e) => isStrip(e) && stripData(e).some(v => v > 0);
const isZone = (e) => (e.bytes[1] >= 0x20 && e.bytes[1] <= 0x27) || e.bytes[1] === 0x91 || e.bytes[1] === 0x92;
const zoneBlack = (e) => e.bytes[14] === 0 && e.bytes[15] === 0 && e.bytes[16] === 0;

const isDark = (e) => (isStrip(e) ? stripData(e).every(v => v === 0) : zoneBlack(e));

// What the LEDs hold after this list: the last word on every register and offset.
function lastWords(list) {
  const last = new Map();
  for (const e of list.filter(l => isStrip(l) || isZone(l))) {
    last.set(e.bytes[1] + ':' + (isStrip(e) ? e.bytes.readUInt16LE(2) : 0), e);
  }
  return [...last.values()];
}

// Every header and zone was reached, and what it holds is black.
function allBlack(list) {
  const words = lastWords(list);
  return REGS.every(reg => words.some(e => e.bytes[1] === reg)) && words.some(isZone) && words.every(isDark);
}

// The chip's process sleeps with the VM, so the longest silence in a phase is the sleep.
function splitAtSleep(list) {
  let at = 0;
  let longest = 0;
  for (let i = 1; i < list.length; i++) {
    const gap = list[i].t - list[i - 1].t;
    if (gap > longest) { longest = gap; at = i; }
  }
  return { before: list.slice(0, at), after: list.slice(at), longest };
}

const eventsSeen = (name, parser) => {
  const parse = parser();
  return lines(name).map(parse).filter(Boolean);
};

const refused = json('refused.json').native || {};
const found = json('found.json').native || {};
const controller = (found.controllers || [])[0] || {};
const serverLog = text('app/server/data/server.log');
const sleepPhase = splitAtSleep(between('suspend', 'poweroff'));
const holdsDelay = (name) => {
  const line = lines(name).find(l => l.includes('Xenon')) || '';
  return /sleep/.test(line) && /shutdown/.test(line) && /delay/.test(line);
};

const checks = [
  ['the kernel really sleeps and wakes', /suspend entry/.test(text('suspend-kernel.txt')) && /suspend exit/.test(text('suspend-kernel.txt'))],
  ['without the rule the user cannot open the node', !/user:xenon:rw/.test(text('acl-before.txt'))],
  ['and the server says so, with the line to paste', refused.error === 'no-permission' && /udevadm trigger/.test(refused.accessCommand || '')],
  ['it says that, not "nothing found"', (refused.controllers || []).length === 0 && refused.error !== 'no-controller'],
  ['the pasted line gives the node to the user at the seat', /user:xenon:rw/.test(text('acl-after.txt'))],
  ['the chip is found and read through sysfs and ioctl', controller.firmware === '1.0.19.6' && controller.outputs === 4 && /SIMULATED/.test(controller.name || '')],
  ['the card is told this is a Beta', found.beta === true],
  ['logind holds the delay inhibitor for sleep and shutdown', holdsDelay('inhibit.txt')],
  ['every report is a 64-byte feature report with id 0xCC', sent.length > 0 && sent.every(e => e.size === 64 && e.rnum === 0xCC && e.rtype === FEATURE_REPORT && e.bytes[0] === 0xCC)],
  ['nothing ever asks to save to the chip', !sent.some(e => FORBIDDEN.includes(e.bytes[1]))],
  ['a colour reaches the chip', between('paint', 'quit').some(isRed)],
  ['quitting Xenon hands the headers back', handedBack(between('quit', 'suspend'))],
  ['sleep darkens every output and zone', allBlack(sleepPhase.before)],
  ['sleep never hands the headers back', !handedBack(between('suspend', 'poweroff'))],
  ['the colour comes back on waking', sleepPhase.after.some(isRed)],
  ['and the inhibitor is held again for the next time', holdsDelay('inhibit-after.txt')],
  ['shutdown darkens every output and zone', allBlack(between('poweroff'))],
  ['shutdown never hands the headers back, SIGTERM included', !handedBack(between('poweroff'))],
  ['the server heard all three', ['suspend', 'resume', 'ending'].every(ev => serverLog.includes('[session-watch] ' + ev))],
  ['gdbus reports the same to a normal user', eventsSeen('gdbus.txt', gdbusParser).join() === 'suspend,resume,ending'],
  ['dbus-monitor reports the same to a normal user', eventsSeen('dbus-monitor.txt', dbusMonitorParser).join() === 'suspend,resume,ending'],
];

let failed = 0;
for (const [promise, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${promise}`);
}
console.log(`\n${checks.length - failed} of ${checks.length} on kernel: ${(/kernel ([^\s,]+)/.exec(text('guest.log')) || [])[1] || 'unknown'}, ${sent.length} reports`);
if (failed) {
  console.log('\nLast lines of guest.log:');
  console.log(lines('guest.log').slice(-15).join('\n'));
}
process.exit(failed ? 1 : 0);
