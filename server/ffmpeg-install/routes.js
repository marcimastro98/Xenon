'use strict';
// GET /api/ffmpeg/status: whether FFmpeg is there and, while it installs, how
// far it got. POST /api/ffmpeg/install: download the pinned build and put it
// in place (ffmpeg-install.js); the answer arrives when it is done, so the
// page polls the status for the bar. The install is for the person at the PC:
// it is refused to paired devices (remote-access.js REMOTE_ADMIN) and needs
// the CSRF check (CSRF_MUTATION_PATHS). No request value reaches the install.

const path = require('node:path');
const { createFfmpegInstall } = require('./ffmpeg-install.js');

let installer = null;
function get(ctx) {
  if (!installer) installer = createFfmpegInstall({ serverDir: path.join(__dirname, '..'), getFfmpegPath: ctx.getFfmpegPath });
  return installer;
}

async function readStatus(req, res, ctx) {
  ctx.json({ ok: true, ...get(ctx).status() });
}

async function install(req, res, ctx) {
  try { ctx.json(await get(ctx).install()); }
  catch (e) { ctx.json({ ok: false, error: 'install_failed', message: String((e && e.message) || e) }); }
}

module.exports = {
  routes: { 'GET /api/ffmpeg/status': readStatus, 'POST /api/ffmpeg/install': install },
};
