'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// linux-trash.js — the recycle-bin half of the disk widget, on Linux.
//
// diskspace.js deletes ONLY through a recycle-bin move, never an unlink: the
// guard resolves every path, and then the shell — not Xenon — performs a
// reversible delete. On Windows that is the helper's `shell-delete`; there is
// no helper here, so the disk widget could analyse a disk and then refuse to
// clean anything on it.
//
// `gio trash` is the exact counterpart: it implements the freedesktop trash
// specification, which is what every Linux file manager shows as "Trash", so a
// file Xenon removes lands somewhere the user already knows how to restore
// from.
//
// Deliberately NOT hand-rolled. The spec is more than "move it to
// ~/.local/share/Trash": each mount point has its own trash directory, a file
// on another filesystem cannot simply be renamed into the home one, and every
// trashed file needs a .trashinfo recording where it came from or it can never
// be put back. Getting any of that subtly wrong loses somebody's data. Where
// gio is missing this refuses and says so, which the widget reports — that is a
// worse feature than deleting, and a far better outcome than a clever one.
// ─────────────────────────────────────────────────────────────────────────────

const { execFile } = require('child_process');

const TRASH_TIMEOUT_MS = 120000;

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      // execFile, never a shell: these are the user's own file names, and a
      // path containing a quote or a semicolon must be a path, not syntax.
      proc = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err) => {
        resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : null });
      });
    } catch {
      resolve({ ok: false, code: null });
      return;
    }
    proc.on('error', () => resolve({ ok: false, code: null }));
  });
}

function createLinuxTrash(o = {}) {
  const gio = o.gioPath || 'gio';
  const runner = typeof o.runner === 'function' ? o.runner : run;

  return async function shellDelete(payload) {
    const p = payload || {};

    if (p.emptyRecycleBin === true) {
      const r = await runner(gio, ['trash', '--empty'], TRASH_TIMEOUT_MS);
      return { ok: r.ok === true };
    }

    const paths = (Array.isArray(p.paths) ? p.paths : [])
      .map((x) => String(x || ''))
      .filter((x) => x.startsWith('/'));
    // Nothing to do is a success, matching the helper: an empty batch means the
    // caller already filtered everything out, not that the delete failed.
    if (!paths.length) return { ok: true };

    const r = await runner(gio, ['trash', '--', ...paths], TRASH_TIMEOUT_MS);
    if (r.ok) return { ok: true };
    // `aborted` is what diskspace.js reads to decide to retry the batch one
    // path at a time, which is exactly what should happen here: gio fails the
    // whole invocation if any single path is refused, so one unreadable file
    // would otherwise be reported as "none of these could be trashed".
    return { ok: false, aborted: true, rc: r.code };
  };
}

module.exports = { createLinuxTrash };
