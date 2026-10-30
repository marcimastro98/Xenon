// Lights left on, flickering, with the PC switched off. Reported by the
// maintainer on a GIGABYTE board driven by Xenon's native lighting: Windows
// never signals node at shutdown, so the headers were never handed back to the
// board and kept Xenon's last frame on standby power. session-watch tells the
// server first; these tests pin the protocol, the lifecycle and the lighting
// side that answers it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionWatch, parseEvent, SCRIPT } = require('../session-watch.js');
const keyLook = require('../lighting-key-look.js');
const P = require('../lighting-native/fusion2-protocol.js');
const { Fusion2Controller } = require('../lighting-native/fusion2.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function fakeSpawn() {
  const spawned = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.cmd = cmd; child.args = args; child.opts = opts;
    child.written = [];
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.write = (s) => { child.written.push(s); return true; };
    child.stdin.end = () => {};
    child.kill = () => { child.killed = true; };
    spawned.push(child);
    return child;
  };
  return { fn, spawned };
}
const settle = () => new Promise((r) => setImmediate(r));

test('only the three event words count, whatever the whitespace', () => {
  assert.equal(parseEvent('ending\r'), 'ending');
  assert.equal(parseEvent(' suspend '), 'suspend');
  assert.equal(parseEvent('resume'), 'resume');
  assert.equal(parseEvent('done'), null);
  assert.equal(parseEvent(''), null);
  assert.equal(parseEvent(undefined), null);
});

test('off Windows nothing is started: a shutdown there sends SIGTERM', () => {
  const sp = fakeSpawn();
  const w = createSessionWatch({ onEvent: () => {}, platform: 'linux', spawnFn: sp.fn });
  w.start();
  assert.equal(sp.spawned.length, 0);
  assert.equal(w.running(), false);
});

test('the host runs hidden from an argv array, never a shell', () => {
  const sp = fakeSpawn();
  const w = createSessionWatch({ onEvent: () => {}, platform: 'win32', spawnFn: sp.fn });
  w.start();
  w.start();
  assert.equal(sp.spawned.length, 1, 'one host, however often start is called');
  const [child] = sp.spawned;
  assert.equal(child.cmd, 'powershell.exe');
  assert.ok(child.args.includes('-File') && child.args.includes(SCRIPT));
  assert.equal(child.opts.windowsHide, true);
  assert.equal(child.opts.shell, undefined);
  w.stop();
});

test('ending and suspend are answered "done" once the server has acted', async () => {
  const sp = fakeSpawn();
  const seen = [];
  let finish;
  const w = createSessionWatch({
    platform: 'win32', spawnFn: sp.fn,
    onEvent: (ev) => { seen.push(ev); return new Promise((r) => { finish = r; }); },
  });
  w.start();
  const [child] = sp.spawned;
  child.stdout.emit('data', 'endi');
  child.stdout.emit('data', 'ng\r\n');
  await settle();
  assert.deepEqual(seen, ['ending']);
  assert.deepEqual(child.written, [], 'no answer before the lights are handed back');
  finish();
  await settle(); await settle();
  assert.deepEqual(child.written, ['done\n']);
  w.stop();
});

test('resume is not answered, and a failing handler still answers', async () => {
  const sp = fakeSpawn();
  const log = { error: () => {} };
  const w = createSessionWatch({
    platform: 'win32', spawnFn: sp.fn, log,
    onEvent: (ev) => { if (ev === 'suspend') throw new Error('usb gone'); },
  });
  w.start();
  const [child] = sp.spawned;
  child.stdout.emit('data', 'resume\nsuspend\n');
  await settle(); await settle(); await settle();
  assert.deepEqual(child.written, ['done\n'], 'only the suspend is answered');
  w.stop();
});

test('stop ends the host and no respawn follows', async () => {
  const sp = fakeSpawn();
  const w = createSessionWatch({ onEvent: () => {}, platform: 'win32', spawnFn: sp.fn });
  w.start();
  const [child] = sp.spawned;
  w.stop();
  assert.equal(child.killed, true);
  child.emit('exit');
  await settle();
  assert.equal(sp.spawned.length, 1);
  assert.equal(w.running(), false);
});

test('a key\'s "lights off" holds until a key or Settings switches them on', () => {
  keyLook.release();
  assert.equal(keyLook.setOut(true), true);
  assert.equal(keyLook.isOut(), true);
  assert.equal(keyLook.setOut(true), false, 'no change, nothing to repaint');
  keyLook.hold({ wholeRig: true });
  assert.equal(keyLook.isOut(), false, 'a key setting a colour switches them back on');
  keyLook.setOut(true);
  assert.equal(keyLook.release(), true, 'back to automatic ends it too');
  assert.equal(keyLook.isOut(), false);
});

// Read from source: switching the lights in a test would connect to a real
// iCUE on a developer's PC and paint the rig.
test('lighting: lights off shows in the status; Settings master on ends it', () => {
  const src = read('../lighting.js');
  assert.match(src, /if \(next\.enabled === true\) keyLook\.setOut\(false\);/);
  assert.match(src, /lightsOut: keyLook\.isOut\(\),/);
  const apply = src.slice(src.indexOf('async function apply()'), src.indexOf('// --- data feeds'));
  assert.match(apply, /if \(keyLook\.isOut\(\)\) \{[\s\S]*?writeDevice\(dev\.id, OFF_COLOR\)[\s\S]*?external\.writeWith\(\(\) => OFF_COLOR\)/);
  const wants = src.slice(src.indexOf('function wantsPaint()'), src.indexOf('function active()'));
  assert.ok(wants.indexOf('poweredDown') < wants.indexOf('isOut'), 'a PC going off wins over lights off');
});

test('lighting: power down and up never throw with no controller', async () => {
  const lighting = require('../lighting.js');
  await lighting.powerDown();
  lighting.powerUp();
  lighting.powerUp();
});

test('controller: after forget the next frame sets the controller up again', async () => {
  const ctl = new Fusion2Controller({ productId: 0x5711 });
  const sent = [];
  ctl.dev = { setFeature: async (buf) => { sent.push(buf); } };
  ctl.orders = [0, 1, 2, 3].map(() => P.byteOrder(0));
  await ctl.write([[{ r: 255, g: 0, b: 0 }], null, null, null]);
  await ctl.release();
  ctl.forget();
  sent.length = 0;
  await ctl.write([[{ r: 255, g: 0, b: 0 }], null, null, null]);
  assert.deepEqual(sent.map(p => p[1]), [0x34, 0x32, 0x58, 0x28], 'counts, take, paint, apply');
});

test('server: the Deck "Lights off" key goes dark and the watch follows native lighting', () => {
  const src = read('../server.js');
  const handler = src.slice(src.indexOf("case 'lightPower': {"), src.indexOf("case 'lightColor':"));
  assert.match(handler, /lighting\.setLightsOut\(!on\)/);
  assert.match(src, /onEvent: \(ev\) => \(ev === 'resume' \? lighting\.powerUp\(\) : lighting\.powerDown\(\)\)/);
  assert.match(src, /_sessionWatch\.stop\(\)/, 'stopped in _gracefulShutdown');
  const script = read('../session-watch.ps1');
  for (const msg of ['WM_QUERYENDSESSION', 'WM_ENDSESSION', 'PBT_APMSUSPEND', 'ENDSESSION_CLOSEAPP']) assert.ok(script.includes(msg), msg);
});

// The real host: it must compile, sit quietly, and leave when the server goes.
test('session-watch.ps1 starts and exits when stdin closes', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(child.exitCode, null, 'still running: ' + stderr);
  const exited = new Promise((r) => child.once('exit', r));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
  if (code === 'timeout') child.kill();
  assert.equal(code, 0, 'exited on its own: ' + stderr);
});

// Windows messages posted to the real host's hidden window: each is reported
// once, Restart Manager closing the app is not a shutdown, a cancelled shutdown
// re-arms, and suspend is reported only once until the wake.
test('session-watch.ps1 reports what Windows tells its window', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const words = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const w = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!w) continue;
      words.push(w);
      if (w === 'ending' || w === 'suspend') child.stdin.write('done\n');
    }
  });
  try {
    await new Promise((r) => setTimeout(r, 4000));
    // [msg, wParam, lParam] in order, posted by a separate process.
    const posts = [
      [0x0011, 0, 1],        // WM_QUERYENDSESSION from Restart Manager: ignored
      [0x0011, 0, 0],        // a real shutdown: ending
      [0x0011, 0, 0],        // asked again: already reported
      [0x0016, 0, 0],        // WM_ENDSESSION false: the shutdown was cancelled
      [0x0011, 0, 0],        // a new shutdown: ending again
      [0x0218, 4, 0],        // PBT_APMSUSPEND: suspend
      [0x0218, 4, 0],        // twice: once
      [0x0218, 0x12, 0],     // PBT_APMRESUMEAUTOMATIC: resume
      [0x0218, 7, 0],        // PBT_APMRESUMESUSPEND right after: already awake
    ];
    const ps = [
      'Add-Type -Namespace W -Name U -MemberDefinition @"',
      '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l);',
      '[DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);',
      '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
      '"@',
      '$target = [IntPtr]::Zero',
      'for ($i = 0; $i -lt 40 -and $target -eq [IntPtr]::Zero; $i++) { $h = [IntPtr]::Zero; while (($h = [W.U]::FindWindowEx([IntPtr]::Zero, $h, [NullString]::Value, [NullString]::Value)) -ne [IntPtr]::Zero) { $p = 0; [void][W.U]::GetWindowThreadProcessId($h, [ref]$p); if ($p -eq ' + child.pid + ') { $target = $h; break } }; if ($target -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 } }',
      'if ($target -eq [IntPtr]::Zero) { Write-Output "nowindow"; exit 1 }',
      ...posts.map(([m, w, l]) => '[void][W.U]::PostMessage($target, ' + m + ', [IntPtr]' + w + ', [IntPtr]' + l + '); Start-Sleep -Milliseconds 300'),
      'Write-Output "posted"',
    ].join('\n');
    const poster = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let out = '';
    poster.stdout.on('data', (d) => { out += d; });
    await new Promise((r) => poster.once('exit', r));
    assert.match(out, /posted/, 'the host has a window to post to: ' + out);
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(words, ['ending', 'ending', 'suspend', 'resume']);
  } finally {
    child.kill();
  }
});

