// The pump screens in a settings backup (server/pump-screen/backup.js): their settings
// and the pictures of the person's own travel; a restore writes each picture under a
// name made on this PC and points the settings at it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { createPumpBackup } = require('../pump-screen/backup.js');
const { createPumpStore } = require('../pump-screen/store.js');
const { BACKUP_BACKGROUND_MAX_BYTES } = require('../settings/backup-format.js');
const Faces = require('../js/pump/pump-faces.js');

function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-pump-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'uploads');
  fs.mkdirSync(dir);
  const store = createPumpStore({ dataDir: root });
  const told = [];
  const backup = createPumpBackup({ store, dir, clock: () => 1700000000000, changed: () => told.push('changed') });
  return { root, dir, store, told, backup };
}

const picture = (...items) => ({ face: 'picture', items });
const screen = (base, moments = []) => ({ base, moments });

test('a backup carries the settings and the pictures a screen shows, never more than fit', async (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.dir, 'pump-1-a.gif'), 'GIF89a');
  fs.writeFileSync(path.join(r.dir, 'pump-2-big.webm'), Buffer.alloc(BACKUP_BACKGROUND_MAX_BYTES));
  fs.writeFileSync(path.join(r.dir, 'pump-3-unused.png'), 'x');
  await r.store.update((m) => ({ model: { ...m, screens: { pump: screen(picture('/uploads/pump-1-a.gif', 'art:tide'), [{ when: { any: [{ c: 'music' }] }, show: picture('/uploads/pump-2-big.webm', '/uploads/pump-9-gone.gif') }]) } } }));
  const out = await r.backup.save();
  assert.deepEqual(Object.keys(out.screens), ['pump']);
  assert.deepEqual(out.pictures, [{ file: 'pump-1-a.gif', data: Buffer.from('GIF89a').toString('base64') }], 'too big together, gone and unused files stay behind');
});

test('a restore writes each picture under a new name and the screens show it', async (t) => {
  const r = rig(t);
  await r.store.remember((m) => ({ model: { ...m, seen: { pump: { shape: 'round', w: 480, h: 480, via: 'icue' } } } }));
  await r.backup.restore({
    v: 1,
    screens: { pump: screen(picture('/uploads/pump-1-a.gif'), [{ when: { any: [{ c: 'music' }] }, show: picture('/uploads/pump-9-gone.gif') }]) },
    pictures: [
      { file: 'pump-1-a.gif', data: Buffer.from('GIF89a').toString('base64') },
      { file: '../evil.gif', data: 'eA==' },
      { file: 'face.svg', data: 'eA==' },
      { file: 'empty.png', data: '' },
    ],
  });
  const written = fs.readdirSync(r.dir);
  assert.equal(written.length, 1, 'only the good picture is written');
  assert.match(written[0], /^pump-1700000000000-[0-9a-f]{1,8}\.gif$/);
  const model = await r.store.ready();
  assert.deepEqual(model.screens.pump.base.items, ['/uploads/' + written[0]]);
  assert.deepEqual(model.screens.pump.moments[0].show.items, [Faces.OWN_ART[0]], 'a picture that did not travel leaves the face its own art');
  assert.equal(model.seen.pump.via, 'icue', 'how the pump was seen is kept');
  assert.deepEqual(r.told, ['changed'], 'the pages and the ring of lights hear of it once');
  const saved = JSON.parse(fs.readFileSync(path.join(r.root, 'pump-screens.json'), 'utf8'));
  assert.deepEqual(saved.screens.pump.base.items, ['/uploads/' + written[0]], 'and it is on disk');
});

test('a restore is read like any save, and a section that is no pump setting is refused', async (t) => {
  const r = rig(t);
  await r.backup.restore({ screens: { pump: { base: { face: 'nope' }, look: { rotate: 33 } }, bad: 'x' } });
  const model = await r.store.ready();
  assert.equal(Faces.FACES.includes(model.screens.pump.base.face), true);
  assert.equal(model.screens.pump.look.rotate, 0);
  await assert.rejects(r.backup.restore(null), /pump_shape/);
  await assert.rejects(r.backup.restore({ screens: 'x' }), /pump_shape/);
  assert.deepEqual(r.told, ['changed'], 'a refused section tells nobody');
});

test('the engine puts the pumps in the backup and gives them back', () => {
  const server = engineSource();
  assert.match(server, /pump: await require\('\.\/pump-screen\/index\.js'\)\.backup\.save\(\)\.catch\(\(\) => null\),/);
  assert.match(server, /if \(d\.pump && typeof d\.pump === 'object'\) await apply\('pump', \(\) => require\('\.\/pump-screen\/index\.js'\)\.backup\.restore\(d\.pump\)\);/);
});
