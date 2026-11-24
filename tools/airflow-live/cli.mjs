#!/usr/bin/env node
// Airflow on a running engine, from a terminal: for the live tests on a real PC
// (wave 1 step 7) and for testers. It reads GET /airflow and, on Windows, what the
// sensor service's hands hold; it changes things only through POST /actions/run,
// the same door the menu, Bit and the Deck use, so the same rules apply.
//
//   node tools/airflow-live/cli.mjs view <port>
//   node tools/airflow-live/cli.mjs act <port> '{"type":"airflowCheck","do":"start"}'
//   node tools/airflow-live/cli.mjs watch <port> <minutes> <out.jsonl> [seconds]
//
// `watch` appends every look to <out.jsonl>, prints a line when something a person
// would notice changed, and ends after <minutes> or when <out.jsonl>.stop appears.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { differs, line, summarize } from './summary.mjs';

const SVC_FRESH_MS = 10000;

function portOf(arg) {
  const port = Number(arg);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`"${arg}" is not a port`);
  return port;
}

async function call(port, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

// The hands' own word, when this PC has the service and it wrote lately.
function serviceState() {
  if (process.platform !== 'win32' || !process.env.ProgramData) return null;
  try {
    const o = JSON.parse(readFileSync(path.join(process.env.ProgramData, 'Xenon Sensors', 'fan.json'), 'utf8'));
    return o && Number.isFinite(o.at) && Date.now() - o.at < SVC_FRESH_MS ? o.data : null;
  } catch { return null; }
}

async function look(port) {
  let view;
  try { view = await call(port, '/airflow'); } catch (e) { view = { ok: false, error: 'no_engine: ' + e.message }; }
  return summarize(view, serviceState());
}

async function watch(port, minutes, out, seconds) {
  if (!(minutes > 0 && minutes <= 720)) throw new Error('minutes: between 1 and 720');
  const until = Date.now() + minutes * 60000;
  let last = null;
  while (Date.now() < until && !existsSync(out + '.stop')) {
    const s = await look(port);
    appendFileSync(out, JSON.stringify(s) + '\n');
    if (differs(last, s)) console.log(line(s));
    last = s;
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
}

async function main([cmd, portArg, ...rest]) {
  const port = portOf(portArg);
  if (cmd === 'view') { console.log(line(await look(port))); return; }
  if (cmd === 'act') { console.log(JSON.stringify(await call(port, '/actions/run', JSON.parse(rest[0] || '{}')))); return; }
  // The log is named, never defaulted: a default landed in the repo root (23 Nov 2026).
  if (cmd === 'watch') {
    if (!rest[1]) throw new Error('usage: cli.mjs watch <port> <minutes> <out.jsonl> [seconds]');
    await watch(port, Number(rest[0]), path.resolve(rest[1]), Math.max(1, Number(rest[2]) || 2));
    return;
  }
  throw new Error('usage: cli.mjs view|act|watch <port> ...');
}

main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
