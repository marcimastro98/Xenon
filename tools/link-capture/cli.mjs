#!/usr/bin/env node
// What another program sends an iCUE LINK hub, to learn the parts of its language Xenon
// does not speak yet (the lights): record the USB traffic with USBPcap while that program
// works, then read the hub's reports as commands. Windows only, USBPcap installed
// (https://desowin.org/usbpcap/), which records only after a restart that follows its install.
//
//   node tools/link-capture/cli.mjs interfaces
//   node tools/link-capture/cli.mjs capture <seconds> <out.pcap> [\\.\USBPcapN]
//   node tools/link-capture/cli.mjs decode <file.pcap> [timeline|answers|writes]
//
// `capture` records every root hub (one file each, <out>-N.pcap) unless one is named, with
// the device descriptors injected so `decode` can find the hub by its ids. A capture carries
// the serial numbers of the devices on the chain: it is never written inside the repo.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCapture, addressOf, reportsOf } from './pcap.mjs';
import { timeline, writes, triples } from './link-decode.mjs';

const USBPCAP = 'C:\\Program Files\\USBPcap\\USBPcapCMD.exe';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HUB = { vid: 0x1b1c, pid: 0x0c3f };
const SNAPLEN = 65535;
const MAX_SECONDS = 600;

function needUsbPcap() {
  if (process.platform !== 'win32') throw new Error('USBPcap records on Windows only');
  if (!existsSync(USBPCAP)) throw new Error(`USBPcap is not installed (${USBPCAP})`);
}

/** The root hubs USBPcap can record, as \\.\USBPcapN. */
function interfaces() {
  needUsbPcap();
  const text = execFileSync(USBPCAP, ['--extcap-interfaces'], { encoding: 'utf8' });
  return [...text.matchAll(/\{value=(\\\\\.\\USBPcap\d+)\}/g)].map((m) => m[1]);
}

function outsideRepo(file) {
  const abs = path.resolve(file);
  const rel = path.relative(REPO, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('a capture carries device serials: write it outside the repo');
  return abs;
}

function record(iface, out, seconds) {
  return new Promise((resolve) => {
    const child = spawn(USBPCAP, ['-d', iface, '-A', '--inject-descriptors', '-s', String(SNAPLEN), '-o', out], { stdio: 'ignore', windowsHide: true });
    const stop = setTimeout(() => child.kill(), seconds * 1000);
    child.on('exit', (code) => { clearTimeout(stop); resolve({ iface, out, code }); });
    child.on('error', (e) => { clearTimeout(stop); resolve({ iface, out, error: e.message }); });
  });
}

async function capture(secondsArg, outArg, iface) {
  const seconds = Number(secondsArg);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS) throw new Error(`seconds: 1..${MAX_SECONDS}`);
  if (!outArg) throw new Error('usage: capture <seconds> <out.pcap> [\\\\.\\USBPcapN]');
  const out = outsideRepo(outArg);
  const list = iface ? [iface] : interfaces();
  if (!list.length) throw new Error('USBPcap sees no root hub: restart the PC once after installing it');
  const base = out.replace(/\.pcap$/i, '');
  const runs = await Promise.all(list.map((f, i) => record(f, list.length > 1 ? `${base}-${i + 1}.pcap` : out, seconds)));
  for (const r of runs) console.log(`${r.iface} -> ${r.out}${r.error ? ` failed: ${r.error}` : ''}`);
}

function decode(file, mode = 'timeline') {
  if (!file) throw new Error('usage: decode <file.pcap> [timeline|answers|writes]');
  const records = readCapture(readFileSync(file));
  const address = addressOf(records, HUB.vid, HUB.pid);
  if (!address) {
    console.log('no iCUE LINK hub in this capture (it records one root hub: try the other files)');
    return;
  }
  const reports = reportsOf(records, address);
  console.log(`hub at ${address}: ${reports.filter((r) => r.out).length} reports to it, ${reports.filter((r) => !r.out).length} back`);
  if (mode === 'writes') {
    for (const g of writes(reports)) {
      console.log(`${g.key}: ${g.count} writes, lengths ${g.lengths.join('/')}, ${g.distinct.length} distinct`);
      for (const d of g.distinct.slice(0, 40)) console.log(`  ${d.t.toFixed(3)}  ${triples(d.payload)}`);
    }
    return;
  }
  for (const line of timeline(reports, { answers: mode === 'answers' })) console.log(line);
}

const [cmd, ...args] = process.argv.slice(2);
const run = { interfaces: () => console.log(interfaces().join('\n') || '(none)'), capture: () => capture(...args), decode: () => decode(...args) }[cmd];
if (!run) {
  console.error('usage: cli.mjs interfaces | capture <seconds> <out.pcap> [iface] | decode <file.pcap> [timeline|answers|writes]');
  process.exit(2);
}
Promise.resolve().then(run).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
