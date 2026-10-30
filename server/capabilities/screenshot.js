'use strict';
// Screenshot capability: save what is on screen (the monitor in use, the
// window in front, or an area the user picks on the frozen screens) as a PNG
// in Pictures/Xenon/<game or Desktop> (or the folder the user chose), or
// show the last one in the file manager. A picked area also goes on the clipboard. The engine (capture-host.js) writes the file;
// the index (captures.js) keeps its path. The result carries the id and the
// file name, never the path.
//
// deps.capture (injected):
//   host     the capture host: available(), request(cmd, body)
//   store    () → the captures index
//   game     () → the running game's process name, '' outside a game
//   mkdir    (dir) → Promise, recursive
//   reveal   (file) → opens its folder with the file selected
//   onSaved  (entry) → told to every dashboard (the toast with "Show");
//            entry.copied says the picture is on the clipboard too
//   hint     () → Promise<string>, the line shown over the area picker, in
//            the user's language
//   shotFolder () → Promise<{ dir, missing }>: the folder the user chose ('' =
//            Pictures/Xenon), missing when the chosen one is gone (optional)

const TARGETS = Object.freeze(['screen', 'window', 'region']);
const MODES = Object.freeze(['take', 'reveal']);
// Engine failures the caller can act on keep their code; the rest are "failed".
const PASS_THROUGH = new Set(['unavailable', 'unsupported', 'no_window', 'no_monitor', 'no_gpu', 'engine_failing']);
// The engine closes an unanswered area picker after 120 s; the request waits a
// little longer so the engine's own answer always arrives first.
const REGION_TIMEOUT_MS = 150000;

const pickerLock = require('./picker-lock.js');

function available(capture) {
  return !!(capture && capture.host && typeof capture.host.available === 'function' && capture.host.available());
}

async function reveal(c) {
  const last = await c.store().last('screenshot');
  if (!last) return { ok: false, error: 'no_file' };
  c.reveal(last.file);
  return { ok: true, shown: true, name: last.name };
}

async function take(c, target) {
  const store = c.store();
  const game = (typeof c.game === 'function' && c.game()) || '';
  let where = { dir: '' };
  if (typeof c.shotFolder === 'function') {
    try { where = (await c.shotFolder()) || where; } catch { /* the default folder still works */ }
  }
  const folderMissing = where.missing === true;
  const plan = await store.plan({ kind: 'screenshot', game, root: where.dir || undefined });
  try { await c.mkdir(plan.dir); } catch { return { ok: false, error: 'write_failed' }; }
  const region = target === 'region';
  let hint = '';
  if (region && typeof c.hint === 'function') {
    try { hint = String(await c.hint() || ''); } catch { /* the picker works without its hint line */ }
  }
  const body = region ? { target, path: plan.file, copy: true, hint } : { target, path: plan.file };
  const reply = await c.host.request('screenshot', body, region ? { timeoutMs: REGION_TIMEOUT_MS } : undefined);
  // Esc or the right button: the user changed their mind, nothing went wrong.
  if (reply && reply.ok === true && reply.cancelled === true) return { ok: true, cancelled: true };
  if (!reply || reply.ok !== true) {
    const code = reply && reply.error;
    return { ok: false, error: PASS_THROUGH.has(code) ? code : 'failed' };
  }
  const entry = store.add({
    id: plan.id, kind: 'screenshot', file: plan.file, game,
    width: reply.width, height: reply.height, hdr: reply.hdr === true,
  });
  if (!entry) return { ok: false, error: 'failed' };
  const copied = reply.copied === true;
  const extra = folderMissing ? { folderMissing } : {};
  try { if (typeof c.onSaved === 'function') c.onSaved({ ...entry, copied, ...extra }); } catch { /* the file is saved either way */ }
  return { ok: true, id: entry.id, name: entry.name, game: entry.game, width: entry.width, height: entry.height, hdr: entry.hdr, copied, ...extra };
}

async function run(d, action) {
  const c = d && d.capture;
  if (!available(c) || typeof c.store !== 'function' || !c.store()) return { ok: false, error: 'unavailable' };
  const mode = MODES.includes(action.mode) ? action.mode : 'take';
  if (mode === 'reveal') return reveal(c);
  // The picker is already on screen, so a second press is answered as done.
  if (pickerLock.held()) return { ok: true, picking: true };
  const target = TARGETS.includes(action.target) ? action.target : 'screen';
  if (target !== 'region') return take(c, target);
  return pickerLock.hold(() => take(c, target));
}

module.exports = { TARGETS, MODES, REGION_TIMEOUT_MS, available, run };
