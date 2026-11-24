'use strict';
// The pump screens in a settings backup: their settings (pump-screens.json) and the
// pictures of the person's own a screen shows (uploads/pump-*), each embedded while the
// pictures stay under BACKUP_BACKGROUND_MAX_BYTES together, as the background does.
// A restore takes each picture through the checks of POST /pump/picture (picture.js): an
// allowed extension, a size and a name made on this PC. The settings then point at the
// new names, and a picture that did not travel leaves the face's own art in its place;
// the model's normalizer (js/pump/pump-model.js) reads every other field, as on any save.

const fsp = require('fs').promises;
const path = require('path');
const Model = require('../js/pump/pump-model.js');
const { writeFileAtomic } = require('../files/atomic-write.js');
const { BACKUP_BACKGROUND_MAX_BYTES, BACKUP_SAFE_NAME_RE } = require('../settings/backup-format.js');
const { usedPictures, extensionOf, nameFor } = require('./picture.js');

const UPLOADS = '/uploads/';
const MAX_PICTURES = 50;

/** @param {{ store: any, dir: string, clock?: () => number, changed?: () => void }} opts */
function createPumpBackup({ store, dir, clock = Date.now, changed = () => {} }) {
  async function save() {
    const model = await store.ready();
    const pictures = [];
    let total = 0;
    for (const file of usedPictures(model)) {
      if (!BACKUP_SAFE_NAME_RE.test(file)) continue;
      try {
        const abs = path.join(dir, file);
        const st = await fsp.stat(abs);
        if (!st.isFile() || total + st.size > BACKUP_BACKGROUND_MAX_BYTES) continue;
        pictures.push({ file, data: (await fsp.readFile(abs)).toString('base64') });
        total += st.size;
      } catch { /* gone from the disk: the restore shows the face's own art */ }
    }
    return { v: model.v, screens: model.screens, direct: model.direct, pictures };
  }

  // Each picture the bundle carries, written under a new name: old name → new name.
  async function writePictures(list) {
    const renamed = new Map();
    for (const p of Array.isArray(list) ? list.slice(0, MAX_PICTURES) : []) {
      if (!p || typeof p.file !== 'string' || !BACKUP_SAFE_NAME_RE.test(p.file) || typeof p.data !== 'string') continue;
      const ext = extensionOf({ originalName: p.file, contentType: '' });
      const buf = Buffer.from(p.data, 'base64');
      if (!ext || !buf.length || buf.length > BACKUP_BACKGROUND_MAX_BYTES) continue;
      const name = nameFor(clock, ext);
      await fsp.mkdir(dir, { recursive: true });
      await writeFileAtomic(path.join(dir, name), buf);
      renamed.set(p.file, name);
    }
    return renamed;
  }

  async function restore(section) {
    if (!section || typeof section !== 'object' || !section.screens || typeof section.screens !== 'object') throw new Error('pump_shape');
    const renamed = await writePictures(section.pictures);
    const point = (show) => {
      if (!show || typeof show !== 'object' || !Array.isArray(show.items)) return show;
      const items = show.items.map((item) => {
        if (typeof item !== 'string' || !item.startsWith(UPLOADS)) return item;
        const now = renamed.get(item.slice(UPLOADS.length));
        return now ? UPLOADS + now : null;
      }).filter(Boolean);
      return { ...show, items };
    };
    const screens = {};
    for (const [id, s] of Object.entries(section.screens)) {
      if (!s || typeof s !== 'object') continue;
      const moments = Array.isArray(s.moments) ? s.moments.map((m) => (m && typeof m === 'object' ? { ...m, show: point(m.show) } : m)) : s.moments;
      screens[id] = { ...s, base: point(s.base), moments };
    }
    const direct = typeof section.direct === 'boolean' ? section.direct : undefined;
    await store.update((cur) => ({ model: Model.normalize({ v: section.v, screens, seen: cur.seen, direct: direct ?? cur.direct }) }));
    changed();
  }

  return { save, restore };
}

module.exports = { createPumpBackup };
