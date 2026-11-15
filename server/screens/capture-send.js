'use strict';
// "Send to phone" for a capture: the file joins the PC → phone list of the
// file transfer (file-transfer.js), so a paired phone sees it in its Files
// tile and downloads it over the local network. No account, no cloud.
//
// The transfer store keeps its own blob, so the capture is HARD-LINKED into it
// when both sit on one drive (instant, no extra space) and copied otherwise.
// The record is marked delivered at the capture's own path: retention may then
// drop Xenon's duplicate once it is old, and never the user's file.
// Sending the same capture again while its earlier copy is still listed
// answers that copy instead of making a second one.

const SEND_ERRORS = new Set(['too_big', 'quota', 'busy', 'not_ready', 'no_space']);

function createCaptureSend({ store, transfer, enabled, phones, sizeOf, link, copyFile, rename, unlink }) {
  const sent = new Map(); // capture id → transfer id

  async function place(src, target) {
    try { await link(src, target); return; } catch { /* other drive or no links: copy */ }
    const part = target + '.part';
    try {
      await copyFile(src, part);
      await rename(part, target);
    } catch (e) {
      await unlink(part).catch(() => {});
      throw e;
    }
  }

  async function send(id) {
    const e = store.get(String(id || ''));
    if (!e) return { ok: false, error: 'not_found' };
    if (!enabled()) return { ok: false, error: 'disabled' };
    if (!(phones() > 0)) return { ok: false, error: 'no_phone' };

    const prev = sent.get(e.id);
    if (prev && transfer.get(prev)) return { ok: true, id: prev, name: e.name, already: true };

    const size = await sizeOf(e.file);
    if (size == null) return { ok: false, error: 'not_found' };
    const began = transfer.begin({ name: e.name, direction: 'out', from: 'PC', declaredLength: size });
    if (began.error) return { ok: false, error: SEND_ERRORS.has(began.error) ? began.error : 'send_failed' };
    try {
      await place(e.file, began.target);
    } catch (err) {
      transfer.abort(began.id);
      return { ok: false, error: err && err.code === 'ENOSPC' ? 'no_space' : 'send_failed' };
    }
    const rec = await transfer.commit(began.id, size);
    if (!rec) return { ok: false, error: 'send_failed' };
    await transfer.markDelivered(rec.id, e.file);
    sent.set(e.id, rec.id);
    return { ok: true, id: rec.id, name: rec.name };
  }

  return { send };
}

module.exports = { createCaptureSend };
