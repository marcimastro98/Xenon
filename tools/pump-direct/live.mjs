// Runs Xenon's own drawing on a real pump screen (server/pump-screen/direct.js with its real parts,
// direct-start.js realParts) for a while, against a running Xenon's /pump-face page, and says each
// change of state and how many pictures reached the screen. Close iCUE (or OpenLinkHub) to see
// Xenon draw; open it again to see Xenon step aside within a check. It never closes either.
// The face page says hello to that Xenon as a screen shown "direct" (kept in memory there only).
// Run: node tools/pump-direct/live.mjs [--seconds 60] [--port 3030] [--screen pump]
// Windows and Linux. Test: server/test/pump-direct-tool.test.mjs.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createPumpDirect } = require('../../server/pump-screen/direct.js');
const { createPumpDetect } = require('../../server/pump-screen/detect.js');
const { realParts, DEFAULT_SCREEN } = require('../../server/pump-screen/direct-start.js');

export function parseArgs(argv) {
  const out = { seconds: 60, port: 3030, screen: DEFAULT_SCREEN };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--seconds') out.seconds = Number(argv[++i]);
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--screen') out.screen = String(argv[++i]);
  }
  if (!(out.seconds > 0 && out.seconds <= 600)) throw new Error('--seconds: 1..600');
  if (!(Number.isInteger(out.port) && out.port > 0 && out.port <= 65535)) throw new Error('--port: 1..65535');
  if (!/^[\w-]{1,40}$/.test(out.screen)) throw new Error('--screen: letters, digits, - and _');
  return out;
}

// What one second of drawing looked like: pictures that reached the screen and their average size.
export function rate(sizes, ms) {
  const n = sizes.length;
  const kb = n ? Math.round(sizes.reduce((a, b) => a + b, 0) / n / 1024) : 0;
  return { fps: Math.round((n * 1000 / ms) * 10) / 10, kb };
}

const stamp = () => new Date().toLocaleTimeString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('Windows and Linux only');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-pump-live-'));
  const parts = realParts({ platform: process.platform, port: opts.port, dataDir, screen: () => opts.screen });
  let sizes = [];
  const direct = createPumpDirect({
    wanted: () => true,
    // A fresh look every time, so a screen plugged in or out shows at once.
    detect: () => createPumpDetect({ warn: (m) => console.log(m) })(),
    ...parts,
    makeLink: (o) => {
      const link = parts.makeLink(o);
      return { ...link, show: (jpeg) => { sizes.push(jpeg.length); link.show(jpeg); } };
    },
    changed: () => console.log(stamp(), JSON.stringify(direct.state())),
  });
  direct.refresh();
  const every = 10;
  try {
    for (let t = 0; t < opts.seconds; t += every) {
      const wait = Math.min(every, opts.seconds - t);
      await sleep(wait * 1000);
      const r = rate(sizes, wait * 1000);
      sizes = [];
      console.log(stamp(), `${r.fps} pictures a second to the screen, ${r.kb} KB each`);
    }
  } finally {
    await direct.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(stamp(), 'stopped: the screen goes back to its own picture by itself');
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
