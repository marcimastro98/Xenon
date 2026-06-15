import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sc = require('../screen-capture.js');

// ── Pure parser ───────────────────────────────────────────────────────────────

test('parseLine decodes a video frame line', () => {
  const r = sc.parseLine('XSFRM 1280 720 42 QUJD');
  assert.deepEqual(r, { type: 'frame', w: 1280, h: 720, seq: 42, data: 'QUJD' });
});

test('parseLine decodes a control line', () => {
  const env = { id: 7, ok: true, out: '{"started":true}', err: '' };
  const b64 = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
  const r = sc.parseLine('XSCTL ' + b64);
  assert.equal(r.type, 'control');
  assert.equal(r.env.id, 7);
});

test('parseLine rejects stray / malformed lines', () => {
  assert.equal(sc.parseLine(''), null);
  assert.equal(sc.parseLine('hello world'), null);
  assert.equal(sc.parseLine('XSFRM 1 2'), null);          // too few fields
  assert.equal(sc.parseLine('XSCTL @@notb64@@@'), null);   // unparseable
});

// ── Host manager, driven by a fake spawned helper (no real exe) ────────────────

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { writes: [], write(s) { this.writes.push(s); return true; } };
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.unref = () => {};
  // Push a helper stdout line through the manager's reader.
  child.emitLine = (line) => child.stdout.emit('data', line + '\n');
  // Read the id from the last stdin command and ack it.
  child.ackLast = (out) => {
    const cmd = JSON.parse(child.stdin.writes[child.stdin.writes.length - 1]);
    const env = { id: cmd.id, ok: true, out: JSON.stringify(out || {}), err: '' };
    child.emitLine('XSCTL ' + Buffer.from(JSON.stringify(env), 'utf8').toString('base64'));
    return cmd;
  };
  return child;
}

function makeHost(over = {}) {
  const child = over.child || fakeChild();
  const host = sc.createScreenCapture({
    helperExe: 'C:\\fake\\xenon-helper.exe',
    existsSync: () => over.exists !== false,
    spawn: () => child,
  });
  return { host, child };
}

test('available() reflects the helper exe presence', () => {
  assert.equal(makeHost({ exists: true }).host.available(), true);
  assert.equal(makeHost({ exists: false }).host.available(), false);
});

test('start() sends a start command with a virtual-monitor default and resolves on ack', async () => {
  const { host, child } = makeHost();
  const p = host.start({ fps: 20, maxWidth: 1280, maxHeight: 720, quality: 60 });
  // The manager has written the command; ack it as the helper would.
  const cmd = child.ackLast({ started: true, device: '\\\\.\\DISPLAY10', width: 1920, height: 1080 });
  const r = await p;
  assert.equal(cmd.action, 'start');
  assert.equal(cmd.monitor, 'virtual');
  assert.equal(cmd.fps, 20);
  assert.equal(r.started, true);
});

test('setMode() commits a resolution on the virtual monitor and resolves on ack', async () => {
  const { host, child } = makeHost();
  const p = host.setMode({ width: 2560, height: 720 });
  const cmd = child.ackLast({ ok: true, code: 'mode_applied', width: 2560, height: 720 });
  const r = await p;
  assert.equal(cmd.action, 'setmode');
  assert.equal(cmd.monitor, 'virtual');   // defaults to the virtual display
  assert.equal(cmd.width, 2560);
  assert.equal(cmd.height, 720);
  assert.equal(r.code, 'mode_applied');
});

test('list() resolves with the monitor array from the helper', async () => {
  const { host, child } = makeHost();
  const p = host.list();
  child.ackLast({ monitors: [{ device: '\\\\.\\DISPLAY10', virtual: true }] });
  const r = await p;
  assert.equal(r.monitors.length, 1);
  assert.equal(r.monitors[0].virtual, true);
});

test('frames are routed to the frame sink with metadata', async () => {
  const { host, child } = makeHost();
  const frames = [];
  host.setFrameSink((data, meta) => frames.push({ data, meta }));
  // Bring the host up so its stdout reader is wired.
  const p = host.list();
  child.ackLast({ monitors: [] });
  await p;
  child.emitLine('XSFRM 640 360 1 QUJD');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { data: 'QUJD', meta: { w: 640, h: 360, seq: 1 } });
});

test('requests reject when the helper exe is absent', async () => {
  const { host } = makeHost({ exists: false });
  await assert.rejects(() => host.start(), /unavailable/);
});

test('shutdown kills the host process', async () => {
  const { host, child } = makeHost();
  const p = host.list();
  child.ackLast({ monitors: [] });
  await p;
  host.shutdown();
  assert.equal(child.killed, true);
});

test('input() forwards a fire-and-forget event with no id', async () => {
  const { host, child } = makeHost();
  const p = host.list();
  child.ackLast({ monitors: [] });
  await p;
  host.input({ kind: 'mouse', subtype: 'down', fx: 0.5, fy: 0.5, button: 'left' });
  const last = JSON.parse(child.stdin.writes[child.stdin.writes.length - 1]);
  assert.equal(last.action, 'input');
  assert.equal(last.kind, 'mouse');
  assert.equal(last.id, undefined);   // ack-less: no request id attached
});

test('input() is a no-op (no throw) when no host is running', () => {
  const { host } = makeHost({ exists: false });
  host.input({ kind: 'mouse', subtype: 'move', fx: 0, fy: 0 });
});

test('idle retire frees the resident process after stop, with no respawn backoff', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const children = [];
    const host = sc.createScreenCapture({
      helperExe: 'C:\\fake\\xenon-helper.exe',
      existsSync: () => true,
      spawn: () => { const c = fakeChild(); children.push(c); return c; },
    });
    const p = host.start({ fps: 15, maxWidth: 320, maxHeight: 240, quality: 50 });
    children[0].ackLast({ started: true });
    await p;

    const sp = host.stop();
    children[0].ackLast({ stopped: true });
    await sp;
    assert.equal(children[0].killed, false);   // still resident right after stop

    mock.timers.tick(46000);                    // …until it stays idle past the window
    assert.equal(children[0].killed, true);

    // A clean idle retire must not arm the crash backoff: the next view respawns now.
    host.start({ fps: 15 });
    assert.equal(children.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test('a host exit rejects in-flight requests', async () => {
  const { host, child } = makeHost();
  const p = host.list();             // in flight, not yet acked
  child.emit('exit');                // helper dies
  await assert.rejects(() => p, /screen host/);
});
