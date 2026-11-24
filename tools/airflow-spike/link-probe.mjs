// One-off spike, Windows: read an iCUE LINK hub directly.
//   node tools/airflow-spike/link-probe.mjs [seconds] [out.json] [--drive] [--colours]
// --drive also sets the fans (never a pump) to 30 % and 70 % and measures the hub's lease.
// --colours paints the chain's lights as Xenon does: red, green, blue, then a white light
// round each part (a chain Xenon cannot lay out yet is named and left dark).
// --with-services runs (read-only, never with --drive) while the CORSAIR services run with
// iCUE closed, and counts the times something else puts the hub back in hardware mode.
// iCUE and the CORSAIR services must be closed first, or both programs talk to the hub
// at once. Software mode turns the hub's lights off until it is back in hardware mode,
// which this always does at the end. Changes the hub's state: on the owner's PC only,
// announced first.

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { runProbe } from './link-probe-run.mjs';

const require = createRequire(import.meta.url);
const hid = require('../../server/hid/hid-windows.js');
const { openReports } = require('../../server/hid/hid-reports-windows.js');
const P = require('../../server/airflow/corsair-link-protocol.js');

const run = promisify(execFile);
const APPS = ['iCUE.exe'];
const SERVICES = ['CorsairService', 'CorsairDeviceControlService', 'iCUEDevicePluginHost'];

async function busy(services) {
  const found = [];
  const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true });
  for (const app of APPS) if (stdout.toLowerCase().includes(`"${app.toLowerCase()}"`)) found.push(app);
  if (!services) return found;
  for (const name of SERVICES) {
    const r = await run('sc', ['query', name], { windowsHide: true }).catch((e) => e);
    if (/STATE\s*:\s*\d+\s+RUNNING/.test(String(r.stdout || ''))) found.push(name);
  }
  return found;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const drive = process.argv.includes('--drive');
  const withServices = process.argv.includes('--with-services');
  const colours = process.argv.includes('--colours');
  if (drive && withServices) throw new Error('--drive never runs beside the CORSAIR services');
  const seconds = Math.min(Math.max(Number(args[0]) || 10, 1), 60);
  const outFile = args[1] || '';
  if (process.platform !== 'win32') throw new Error('this probe runs on Windows');
  const running = await busy(!withServices);
  if (running.length) {
    console.log(`Close these first: ${running.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const all = await hid.list({ vendorId: P.VENDOR_ID, productIds: [P.HUB_PRODUCT_ID] });
  // Only the command interface: the hub's other one sends its own reports.
  const iface = all.filter((d) => d.usagePage === P.USAGE_PAGE && d.outputLength === P.REPORT_BYTES);
  if (!iface.length) {
    console.log('No iCUE LINK System Hub found.');
    process.exitCode = 3;
    return;
  }
  const link = await openReports(iface.slice(0, 1));
  const result = await runProbe({ link, leadingZero: true, seconds, drive, watchMode: withServices, colours, log: (s) => console.log(s), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  if (outFile) await writeFile(outFile, JSON.stringify(result, null, 2));
  if (!result.backToHardware) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
