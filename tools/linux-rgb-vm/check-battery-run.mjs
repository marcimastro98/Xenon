#!/usr/bin/env node
// Reads what a battery run left and prints one line per promise; exit 1 on any failure.
// node check-battery-run.mjs <folder of the run>
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];

const lines = (file) => {
  const text = fs.existsSync(path.join(DIR, file)) ? fs.readFileSync(path.join(DIR, file), 'utf8') : '';
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
};
const json = (file) => lines(file)[0] || {};
const text = (file) => (fs.existsSync(path.join(DIR, file)) ? fs.readFileSync(path.join(DIR, file), 'utf8') : '');

const marks = Object.fromEntries(lines('marks.jsonl').map((m) => [m.mark, m.t]));
const seen = lines('devices.jsonl');
const between = (from, to) => seen.filter((e) => e.t >= (marks[from] ?? 0) && e.t <= (marks[to] ?? Infinity));
const refused = json('read-refused.json');
const allowed = json('read-allowed.json');
const off = json('read-switched-off.json');
const named = (part) => (allowed.devices || []).find((d) => d.name.includes(part));
const asked = between('allowed-start', 'allowed-end');
const wire = (device) => asked.filter((e) => e.device === device);

const CHECKS = [
  ['without the rule the reader reports the refusal', refused.available === true && refused.access?.kind === 'udev'],
  ['without the rule nothing lists and nothing is sent', refused.devices?.length === 0 && between('refused-start', 'refused-end').length === 0],
  ['the node belonged to root before the rule', !text('acl-before.txt').includes('user:xenon')],
  ['the pasted line gave the node to the person', text('acl-after.txt').includes('user:xenon:rw')],
  ['the receiver read over feature reports: 28%', named('Akko')?.percent === 28],
  ['the headset read over output and input reports: 50%', named('PRO X')?.percent === 50],
  ['both carry the dongle source', named('Akko')?.source === 'dongle' && named('PRO X')?.source === 'dongle'],
  ['no refusal is left once access is there', allowed.access === null],
  ['a receiver that never answers costs only itself', wire('Silent receiver').length > 0 && allowed.devices?.length === 2],
  ['a product outside the table gets nothing', seen.every((e) => e.device !== 'Not in the table')],
  ['the receiver got only the status request', wire('Akko 2.4G Wireless Keyboard').every((e) => e.get === 0 || e.set?.startsWith('00f7'))],
  ['the headset got only the battery question', wire('Logitech PRO X Wireless Gaming Headset').every((e) => e.out?.startsWith('11ff060d'))],
  ['the receiver report is 64 bytes plus the id', wire('Akko 2.4G Wireless Keyboard').some((e) => e.set?.length === 130)],
  ['with asking switched off no device is touched', off.available === true && off.devices?.length === 0 && between('allowed-end', 'switched-off-end').length === 0],
];

let failed = 0;
for (const [promise, ok] of CHECKS) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${promise}`);
}
process.exit(failed ? 1 : 0);
