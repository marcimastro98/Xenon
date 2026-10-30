'use strict';
// "Save as" for everything the dashboard exports (backup, shared presets, the
// share card): the browser's own save dialog where there is one, so the user
// picks the folder and the name; elsewhere (Firefox, a phone, a page inside a
// frame) the normal download. The dialog opens first, inside the click, and
// the file is made after: making it first can outlast the click's permission
// to open a dialog.
(function () {
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function ask(name, types) {
    if (typeof window.showSaveFilePicker !== 'function') return null;
    try {
      return await window.showSaveFilePicker({ suggestedName: name, types });
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      return null;   // not allowed here (a frame, no click left): download instead
    }
  }

  // make: async () => Blob. types: [{ description, accept: { 'mime/type': ['.ext'] } }].
  // Resolves 'saved' (where the user chose), 'downloaded' or 'cancelled'.
  async function save({ name, types, make }) {
    const handle = await ask(name, types);
    if (handle === 'cancelled') return 'cancelled';
    let blob;
    try {
      blob = await make();
    } catch (e) {
      // The dialog already made an empty file: take it back.
      if (handle && typeof handle.remove === 'function') { try { await handle.remove(); } catch { /* best effort */ } }
      throw e;
    }
    if (!handle) { download(blob, name); return 'downloaded'; }
    const out = await handle.createWritable();
    try {
      await out.write(blob);
      await out.close();
    } catch (e) {
      try { await out.abort(); } catch { /* already closed */ }
      throw e;
    }
    return 'saved';
  }

  const JSON_TYPE = { description: 'JSON', accept: { 'application/json': ['.json'] } };
  const TEXT_TYPE = { description: 'Text', accept: { 'text/plain': ['.txt'] } };
  const PNG_TYPE = { description: 'PNG', accept: { 'image/png': ['.png'] } };

  // Today as YYYY-MM-DD in the user's own time zone, for file names.
  function today(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  window.XenonSaveFile = { save, download, today, JSON_TYPE, TEXT_TYPE, PNG_TYPE };
})();
