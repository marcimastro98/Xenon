'use strict';
// The recordings folder: chosen with the system's folder dialog (the capture
// engine's pick_folder), checked like the transfer inbox (never inside Xenon's
// own folders, never a link), and checked again at every recording, so an
// unplugged drive falls back to Videos with a word to the user instead of a
// recording that fails.
//
// The engine answers pick_folder at once and sends the choice later as an
// event line, so screenshots and recordings go on while the dialog is open.

// The engine closes a forgotten dialog after 300 s; this waits a little longer
// so the engine's own answer arrives first.
const PICK_TIMEOUT_MS = 310000;

function createCaptureFolder({ host, validDir, title = () => '' }) {
  let pending = null;

  // `{ ok, path }`, `{ ok, cancelled }` or `{ ok: false, error }`. A second
  // call while the dialog is open waits for the same answer.
  function pick(start = '') {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      let off = () => {};
      let timer = null;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        resolve(result);
      };
      off = host.onEvent((ev) => {
        if (!ev) return;
        if (ev.event === 'folder_picked') {
          if (typeof ev.path === 'string' && ev.path) finish({ ok: true, path: ev.path });
          else if (ev.cancelled === true) finish({ ok: true, cancelled: true });
          else finish({ ok: false, error: 'failed' });
        } else if (ev.event === 'engine_exited') {
          finish({ ok: false, error: 'failed' });
        }
      });
      timer = setTimeout(() => finish({ ok: true, cancelled: true }), PICK_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      // The title is read in the user's language, which may come from disk.
      Promise.resolve()
        .then(() => title())
        .then((t) => (typeof t === 'string' ? t : ''), () => '')   // the dialog has a title of its own
        .then((label) => host.request('pick_folder', { title: label, start: String(start || '') }))
        .then((reply) => {
          if (reply && reply.ok === true) return;
          finish({ ok: false, error: reply && reply.error === 'unsupported' ? 'unsupported' : 'failed' });
        }, () => finish({ ok: false, error: 'failed' }));
    });
    pending.finally(() => { pending = null; });
    return pending;
  }

  // The dialog, then the same checks a typed path would get.
  async function choose(start) {
    const picked = await pick(start);
    if (!picked.ok || picked.cancelled) return picked;
    const check = await validDir(picked.path);
    return check && check.ok ? { ok: true, path: picked.path } : { ok: false, error: (check && check.error) || 'failed' };
  }

  // Where the next recording goes: `{ dir }` for the chosen folder, `{ dir: '' }`
  // for the default, `{ dir: '', missing: true }` when the chosen one is gone.
  async function resolve(folder) {
    if (!folder) return { dir: '' };
    const check = await validDir(folder).catch(() => null);
    return check && check.ok ? { dir: folder } : { dir: '', missing: true };
  }

  return { pick, choose, resolve, picking: () => !!pending };
}

module.exports = { createCaptureFolder, PICK_TIMEOUT_MS };
