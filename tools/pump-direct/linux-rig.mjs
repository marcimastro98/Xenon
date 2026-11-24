// Xenon drawing on a CORSAIR pump screen on Linux, end to end, with no Linux PC and no pump.
// Run as root on any Linux; on Windows through WSL:
//   wsl -d <distro> -u root -- node tools/pump-direct/linux-rig.mjs [--user <name>] [--out <dir>]
// In a mount namespace of its own it puts a pretend pump (1B1C:0C4E, report-stream.mjs) where the
// kernel lists HID devices (/sys/class/hidraw) and a pipe where its node would be (/dev/hidrawN),
// starts a throwaway Xenon as a normal user (Chromium refuses root) with the real direct route
// (XENON_PUMP_DIRECT=1: real detection, hid-linux.js, the system's own Chromium), and reads what it
// writes as the screen would. Steps: no access to the node, access given and Try again, OpenLinkHub
// opening and closing, the switch off, Xenon closing. Exit 0 = every step passed. --out keeps two
// of the pictures. Not tested here: the kernel's hidraw driver and a real udev rule (the pipe takes
// any write the node would take). Test of the pure parts: server/test/pump-direct-tool.test.mjs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyEngine } from '../ci/request-check.mjs';
import { request, rigEnvironment, stopChild } from '../ci/engine-rig.mjs';
import { createReportStream, jpegSize, normalUser, PANEL, PUMP_DESCRIPTOR, pumpUevent } from './report-stream.mjs';

const SYS_HIDRAW = '/sys/class/hidraw';
const PORT = 3048;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString();
const results = [];

function argsOf(argv) {
  const at = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : '');
  return { user: at('--user'), out: at('--out') };
}

function must(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${(r.stderr || r.error?.message || '').trim()}`);
}

// A node name no device has: the pretend pump never shadows a real one.
function freeNode() {
  for (let n = 90; n < 200; n++) if (!fs.existsSync(`/dev/hidraw${n}`)) return `hidraw${n}`;
  throw new Error('no free hidraw name');
}

function pretendPump(work) {
  const name = freeNode();
  const dev = path.join(work, 'sys', name, 'device');
  fs.mkdirSync(dev, { recursive: true });
  fs.writeFileSync(path.join(dev, 'uevent'), pumpUevent());
  fs.writeFileSync(path.join(dev, 'report_descriptor'), PUMP_DESCRIPTOR);
  const node = '/dev/' + name;
  must('mkfifo', ['-m', '600', node]);   // root's alone: what a pump is before a udev rule
  return { sys: path.join(work, 'sys'), node };
}

// Puts the pretend list where the kernel keeps it. A kernel with no HID device yet (WSL) has no
// /sys/class/hidraw: then /sys/class becomes a fresh folder in this namespace with every class
// it had mounted back in place, plus hidraw. Every mount goes on `mounts`, so the end takes them
// off newest first before anything is deleted.
function mountHidraw(sys, work, mounts) {
  const mount = (args, at) => { must('mount', [...args, at]); mounts.push(at); };
  if (!fs.existsSync(SYS_HIDRAW)) {
    const saved = path.join(work, 'class');
    fs.mkdirSync(saved);
    mount(['--bind', '/sys/class'], saved);
    mount(['-t', 'tmpfs', 'tmpfs'], '/sys/class');
    for (const name of fs.readdirSync(saved)) {
      fs.mkdirSync(path.join('/sys/class', name));
      mount(['--bind', path.join(saved, name)], path.join('/sys/class', name));
    }
    fs.mkdirSync(SYS_HIDRAW);
  }
  mount(['--bind', sys], SYS_HIDRAW);
}

// Takes the mounts off and says whether anything is still mounted inside `work`: then it is
// left on disk, never deleted through a mount into the real /sys.
function unmountAll(mounts, work) {
  for (const at of mounts.reverse()) spawnSync('umount', [at]);
  return !fs.readFileSync('/proc/self/mounts', 'utf8').split('\n').some((l) => (l.split(' ')[1] || '').startsWith(work));
}

// The longest wait between two pictures since `from`, the time left before now included.
const longestGap = (times, from) => {
  let last = from; let gap = 0;
  for (const t of times.filter((x) => x >= from)) { gap = Math.max(gap, t - last); last = t; }
  return Math.max(gap, Date.now() - last);
};

// Reads the node as the screen would: whatever Xenon wrote, put back together into pictures.
function screenReader(node) {
  const seen = { pictures: [], stray: 0, last: null, first: null };
  const push = createReportStream({
    onPicture: (jpeg) => { seen.pictures.push(Date.now()); seen.last = jpeg; seen.first ||= jpeg; },
    onStray: () => { seen.stray += 1; },
  });
  const fd = fs.openSync(node, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const buf = Buffer.alloc(64 * 1024);
  const timer = setInterval(() => {
    for (;;) {
      let n = 0;
      try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (e) { if (e.code !== 'EAGAIN') throw e; }
      if (!n) return;
      push(buf.subarray(0, n));
    }
  }, 5);
  seen.since = (t) => seen.pictures.filter((x) => x >= t).length;
  seen.close = () => { clearInterval(timer); fs.closeSync(fd); };
  return seen;
}

function browsersOf(folder) {
  return fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
    try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(path.join(folder, 'server', 'data', 'pump-screen-browser')); } catch { return false; }
  }).length;
}

async function waitFor(check, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v || Date.now() > until) return v;
    await sleep(250);
  }
}

function step(name, ok, detail) {
  results.push(ok);
  console.log(stamp(), ok ? 'PASS' : 'FAIL', name, detail ? `(${detail})` : '');
}

async function steps({ engine, screen, node, folder, work, out }) {
  const ask = async (body) => (await request(PORT, { method: 'POST', path: '/actions/run', body }))?.json;
  const state = async () => (await ask({ type: 'pumpGet' }))?.direct || null;
  const is = (want) => async () => { const s = await state(); return s && s.state === want ? s : null; };

  const denied = await waitFor(is('failed'), 45000);
  step('no access to the node: it fails and says why', denied?.reason === 'no-permission', JSON.stringify(denied));

  fs.chmodSync(node, 0o666);   // what the udev rule in the Linux guide gives the person
  await ask({ type: 'pumpDirect', on: 'on' });   // the menu's Try again
  const t0 = Date.now();
  const drawing = await waitFor(async () => (screen.since(t0) >= 10 ? is('drawing')() : null), 45000);
  // A face only sends a picture when it changes, and the keeper resends the last one every 10 s
  // (lcd-link.js): the screen, which holds a picture about 31 s, is never left without one.
  const t1 = Date.now();
  await sleep(25000);
  const gap = longestGap(screen.pictures, t1);
  const rate = Math.round((screen.since(t1) / ((Date.now() - t1) / 1000)) * 10) / 10;
  const size = screen.last && jpegSize(screen.last);
  step('access given, Try again: it draws', !!drawing && gap <= 11000 && rate <= 21 && screen.stray === 0,
    `longest wait ${(gap / 1000).toFixed(1)} s, ${rate} pictures a second, ${screen.stray} other reports`);
  step('every picture is a whole JPEG at the panel size', size?.width === PANEL.width && size?.height === PANEL.height, JSON.stringify(size));
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'linux-first.jpg'), screen.first);
    fs.writeFileSync(path.join(out, 'linux-last.jpg'), screen.last);
  }

  const app = path.join(work, 'OpenLinkHub');
  fs.copyFileSync('/usr/bin/sleep', app);
  fs.chmodSync(app, 0o755);
  const holder = spawn(app, ['600'], { stdio: 'ignore' });
  const busy = await waitFor(is('busy'), 15000);
  const quiet = Date.now() + 1500;
  await sleep(3500);
  step('OpenLinkHub opens: Xenon steps aside', busy?.app === 'OpenLinkHub' && screen.since(quiet) === 0 && browsersOf(folder) === 0, JSON.stringify(busy));
  holder.kill();
  const back = Date.now();
  const again = await waitFor(async () => (screen.since(back) >= 5 ? is('drawing')() : null), 30000);
  step('OpenLinkHub closes: Xenon draws again', !!again, `${screen.since(back)} pictures`);

  await ask({ type: 'pumpDirect', on: 'off' });
  const off = await waitFor(is('off'), 10000);
  const offAt = Date.now() + 1000;
  await sleep(3000);
  step('the switch off: nothing more reaches the screen', !!off && screen.since(offAt) === 0 && browsersOf(folder) === 0);

  await ask({ type: 'pumpDirect', on: 'on' });
  await waitFor(is('drawing'), 30000);
  await stopChild(engine);
  const gone = Date.now() + 1000;
  await sleep(3000);
  step('Xenon closes: its browser goes and the screen is left alone', screen.since(gone) === 0 && browsersOf(folder) === 0);
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Linux only; on Windows: wsl -d <distro> -u root -- node tools/pump-direct/linux-rig.mjs');
  if (process.getuid() !== 0) throw new Error('run as root: it mounts a pretend device in a namespace of its own');
  if (!process.env.XENON_PUMP_RIG_NS) {
    const r = spawnSync('unshare', ['--mount', '--propagation', 'private', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, XENON_PUMP_RIG_NS: '1' } });
    process.exitCode = r.status ?? 1;
    return;
  }
  const opts = argsOf(process.argv.slice(2));
  const who = normalUser(fs.readFileSync('/etc/passwd', 'utf8'), opts.user);
  if (!who) throw new Error('no normal user to run Xenon as (--user <name>)');
  const work = fs.mkdtempSync('/tmp/xenon-pump-rig-');
  const { sys, node } = pretendPump(work);
  let engine = null;
  let screen = null;
  let folder = '';
  const mounts = [];
  try {
    mountHidraw(sys, work, mounts);
    screen = screenReader(node);
    console.log(stamp(), 'copying the engine');
    folder = copyEngine();
    const env = { ...rigEnvironment(process.env, folder, PORT), XENON_PUMP_DIRECT: '1' };
    must('chown', ['-R', `${who.uid}:${who.gid}`, folder]);   // after rigEnvironment made its home and temp
    delete env.XENON_PUMP_RIG_NS;
    const log = fs.openSync(path.join(work, 'engine.log'), 'w');
    engine = spawn(process.execPath, ['server/server.js'], { cwd: folder, env, uid: who.uid, gid: who.gid, stdio: ['ignore', log, log] });
    const up = await waitFor(async () => (await request(PORT, { path: '/version' }))?.json?.version, 90000);
    console.log(stamp(), `Xenon ${up || 'did not start'} as ${who.user}, pretend pump at ${node}`);
    if (up) await steps({ engine, screen, node, folder, work, out: opts.out });
    else step('Xenon starts', false, fs.readFileSync(path.join(work, 'engine.log'), 'utf8').slice(-800));
  } finally {
    await stopChild(engine);
    screen?.close();
    const clear = unmountAll(mounts, work);
    fs.rmSync(node, { force: true });
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
    if (clear) fs.rmSync(work, { recursive: true, force: true });
    else console.error(`${work} still has a mount inside: left on disk`);
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(stamp(), failed ? `${failed} of ${results.length} steps failed` : `all ${results.length} steps passed`);
  process.exitCode = failed || !results.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
