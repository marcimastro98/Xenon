'use strict';
// The one pop-up about the FPS permission (5.1.1). Since 5.1.0 the engine runs
// with normal rights, so frame rates need Performance Log Users, active only
// from the next Windows sign-in (fps-access.js). The Game performance tile and
// Settings say it; this pop-up reaches everyone else, dashboard and "widgets
// only" alike (SSE `fps_access`, js/alert-toasts.js fpsAccess).
//
// Said when it is true and matters: a game runs and its frames cannot be read.
// At most once per Xenon version and per case, remembered in DATA_DIR, so it
// never turns into a pop-up at every game. It rides on the system tick.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../atomic-write.js');

const MARKER = 'fps-access-notice.json';
const KINDS = ['signin', 'refused'];

// deps: { access: { current(), worthTelling() }, readerReady(), dataDir, version, broadcast(payload) }
function createFpsNotice(deps) {
  const d = deps || {};
  let told = null;      // { version, kinds: [] } once read
  let busy = false;

  async function load() {
    try {
      const o = JSON.parse(await fs.promises.readFile(path.join(d.dataDir, MARKER), 'utf8'));
      const kinds = Array.isArray(o && o.kinds) ? o.kinds.filter((k) => KINDS.includes(k)) : [];
      return o && o.version === d.version ? { version: d.version, kinds } : { version: d.version, kinds: [] };
    } catch { return { version: d.version, kinds: [] }; }
  }

  function kindNow(game) {
    if (!game || !d.dataDir || !d.version) return null;
    try {
      if (typeof d.readerReady === 'function' && d.readerReady() !== true) return null;
      if (d.access.current() == null) return null; // also starts the background check
      const k = d.access.worthTelling();
      return KINDS.includes(k) ? k : null;
    } catch { return null; }
  }

  // Every system tick. `running` is the game in front ('' = none).
  async function onTick(running) {
    const game = typeof running === 'string' ? running : '';
    const kind = kindNow(game);
    if (!kind || busy) return null;
    busy = true;
    try {
      if (!told) told = await load();
      if (told.kinds.includes(kind)) return null;
      told.kinds.push(kind);
      await writeFileAtomic(path.join(d.dataDir, MARKER), JSON.stringify({ version: d.version, kinds: told.kinds }));
      const payload = { game, access: kind === 'signin' ? 'signin' : 'rights' };
      if (typeof d.broadcast === 'function') d.broadcast(payload);
      return payload;
    } catch { return null; } finally { busy = false; }
  }

  return { onTick };
}

module.exports = { createFpsNotice, MARKER };
