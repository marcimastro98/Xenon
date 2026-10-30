import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCaptureSend } = require('../capture-send.js');
const { createFileTransfer } = require('../file-transfer.js');
const sendCapture = require('../capabilities/send-capture.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

async function rig(o = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xenon-send-'));
  const capDir = path.join(dir, 'Videos');
  await fs.mkdir(capDir);
  const file = path.join(capDir, 'Clip 1.mp4');
  await fs.writeFile(file, Buffer.alloc(2048, 7));
  const entry = { id: 'c1', kind: 'recording', file, name: 'Clip 1.mp4', createdAt: 1 };
  const store = { get: (id) => (id === entry.id ? entry : null) };
  const transfer = createFileTransfer({ dir: path.join(dir, 'transfer'), ...(o.transfer || {}) });
  await transfer.init();
  const fsOps = {
    sizeOf: (p) => fs.stat(p).then((s) => s.size, () => null),
    link: o.link || ((a, b) => fs.link(a, b)),
    copyFile: (a, b) => fs.copyFile(a, b),
    rename: (a, b) => fs.rename(a, b),
    unlink: (p) => fs.unlink(p),
  };
  const send = createCaptureSend({
    store, transfer, enabled: () => o.enabled !== false, phones: () => (o.phones == null ? 1 : o.phones), ...fsOps,
  });
  return { dir, file, entry, transfer, send, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('a capture joins the PC to phone list, the original untouched', async () => {
  const r = await rig();
  try {
    const out = await r.send.send('c1');
    assert.equal(out.ok, true);
    const [rec] = r.transfer.list({ includePaths: true });
    assert.equal(rec.id, out.id);
    assert.equal(rec.name, 'Clip 1.mp4');
    assert.equal(rec.direction, 'out');
    assert.equal(rec.size, 2048);
    // Delivered at the capture itself: retention may drop only Xenon's duplicate.
    assert.equal(rec.deliveredPath, r.file);
    assert.equal((await fs.readFile(r.transfer.absOf(r.transfer.get(out.id)))).length, 2048);
    // Taking it out of the list never touches the user's file.
    await r.transfer.remove(out.id);
    assert.equal((await fs.stat(r.file)).size, 2048);
  } finally { await r.cleanup(); }
});

test('the same capture again answers the copy already listed', async () => {
  const r = await rig();
  try {
    const a = await r.send.send('c1');
    const b = await r.send.send('c1');
    assert.equal(b.already, true);
    assert.equal(b.id, a.id);
    assert.equal(r.transfer.list().length, 1);
    await r.transfer.remove(a.id);
    const c = await r.send.send('c1');
    assert.equal(c.already, undefined);
    assert.notEqual(c.id, a.id);
  } finally { await r.cleanup(); }
});

test('another drive: copied through a .part, nothing left behind', async () => {
  const r = await rig({ link: async () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; } });
  try {
    const out = await r.send.send('c1');
    assert.equal(out.ok, true);
    const files = await fs.readdir(r.transfer.filesDir);
    assert.deepEqual(files.filter((f) => f.endsWith('.part')), []);
    assert.equal(files.length, 1);
  } finally { await r.cleanup(); }
});

test('refusals: unknown id, transfer off, no phone, over the size limit', async () => {
  let r = await rig();
  try { assert.deepEqual(await r.send.send('nope'), { ok: false, error: 'not_found' }); } finally { await r.cleanup(); }
  r = await rig({ enabled: false });
  try { assert.deepEqual(await r.send.send('c1'), { ok: false, error: 'disabled' }); } finally { await r.cleanup(); }
  r = await rig({ phones: 0 });
  try { assert.deepEqual(await r.send.send('c1'), { ok: false, error: 'no_phone' }); } finally { await r.cleanup(); }
  r = await rig({ transfer: { maxBytes: 1000 } });
  try {
    assert.deepEqual(await r.send.send('c1'), { ok: false, error: 'too_big' });
    assert.equal(r.transfer.stats().inflight, 0);
  } finally { await r.cleanup(); }
});

test('a capture deleted on disk is not_found, and frees its reservation', async () => {
  const r = await rig();
  try {
    await fs.unlink(r.file);
    assert.deepEqual(await r.send.send('c1'), { ok: false, error: 'not_found' });
    assert.equal(r.transfer.stats().inflight, 0);
  } finally { await r.cleanup(); }
});

test('the Deck key and Bit pick the newest, and say errors the Deck can explain', async () => {
  const shot = { id: 's1', kind: 'screenshot', name: 'Shot.png', createdAt: 5 };
  const video = { id: 'v1', kind: 'recording', name: 'Clip.mp4', createdAt: 3 };
  const store = {
    get: (id) => [shot, video].find((e) => e.id === id) || null,
    last: async (kind) => (kind === 'screenshot' ? shot : kind === 'recording' ? video : null),
    list: () => [shot, video],
  };
  const asked = [];
  const d = { capture: { store: () => store, send: async (id) => { asked.push(id); return { ok: true, id: 'f1' }; } } };
  assert.deepEqual(await sendCapture.run(d, {}), { ok: true, name: 'Shot.png' });
  assert.deepEqual(await sendCapture.run(d, { what: 'video' }), { ok: true, name: 'Clip.mp4' });
  assert.deepEqual(await sendCapture.run(d, { name: 'clip' }), { ok: true, name: 'Clip.mp4' });
  assert.deepEqual(asked, ['s1', 'v1', 'v1']);
  for (const [raw, code] of [['too_big', 'send_too_big'], ['busy', 'send_busy'], ['quota', 'send_full'], ['disabled', 'transfer_off'], ['no_phone', 'no_phone'], ['weird', 'send_failed']]) {
    const bad = { capture: { store: () => store, send: async () => ({ ok: false, error: raw }) } };
    assert.deepEqual(await sendCapture.run(bad, {}), { ok: false, error: code });
  }
  assert.deepEqual(await sendCapture.run({}, {}), { ok: false, error: 'unavailable' });
  const DeckErrorText = require('../js/deck-error-text.js');
  for (const code of ['no_phone', 'transfer_off', 'send_too_big', 'send_full', 'send_busy', 'no_space']) {
    assert.ok(read('js/deck-error-text.js').includes(`    ${code}: [`), code);
  }
  assert.ok(DeckErrorText);
});

test('wired everywhere: catalog, route at the PC only, gallery button', () => {
  const c = CAPABILITIES.find((x) => x.type === 'sendCapture');
  assert.ok(c);
  assert.equal(c.capability.ai.name, 'send_capture_to_phone');
  assert.ok(!c.capability.sdk, 'no SDK category: sending files off the PC is the user\'s');
  assert.match(read('capabilities/index.js'), /case 'sendCapture': return sendCapture\.run\(d, action\);/);
  const server = read('server.js');
  assert.match(server, /reqPath === '\/captures\/send' && req\.method === 'POST'/);
  assert.match(server, /'\/captures\/copy',\r?\n {2}'\/captures\/send',/, 'CSRF');
  assert.match(read('remote-access.js'), /'\/captures\/send',/, 'REMOTE_DENY');
  assert.match(server, /sendable: transferEnabled\(\) && remoteAccess\.count\(\) > 0/);
  assert.match(read('js/capture-gallery-viewer.js'), /if \(o\.sendable\) actions\.appendChild\(btn\(tr\('capg_send'/);
  assert.match(read('js/capture-gallery.js'), /sendable: g\.sendable === true && !window\.__xenonRemote/);
});
