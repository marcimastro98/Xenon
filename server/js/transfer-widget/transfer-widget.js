'use strict';
// File transfer — moving photos, videos and files between the user's phone and
// this PC, on their own network, instead of routing them through a messaging
// service and downloading them again on the other side.
//
// ONE module, two presentations: a tile (the list, and a drop zone on the PC)
// and a full-screen sheet opened from the phone dock. The dock button exists
// because phone-view.js restacks the SAME dashboard — the tile is only on
// screen if the user put it on their PC layout, and the primary action on a
// phone cannot depend on that.
//
// Uploads go through XMLHttpRequest, deliberately: fetch() has no upload
// progress event, request streams need duplex:'half' and HTTP/2, and this is
// HTTP/1.1 to a LAN address, often from Safari. Do not "modernise" this into a
// silent regression — the progress bar is the whole reassurance during a
// two-minute video.
//
// Filenames come off the network and off other people's devices: textContent
// everywhere, never innerHTML except for the static SVG below.
(function () {
  const S = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    // static, trusted SVG
    up: S('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
    down: S('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
    open: S('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'),
    folder: S('<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/>'),
    trash: S('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>'),
    close: S('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    photo: S('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'),
    file: S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>'),
    help: S('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6"/><path d="M12 17.2h.01"/>'),
  };

  const {
    t, el, fmtAge, note, sectionPage, folderError, folderHint, folderName,
  } = window.TransferWidgetSays;
  const api = apiJson;
  const server = () => (typeof SERVER === 'string' ? SERVER : '');

  const {
    held, localProgress, queue, sendRun, tiles, isRemote, settings, setup,
  } = window.TransferWidgetKnown;
  const { sheetHold, onBack } = window.TransferWidgetSheetSteps;
  // The last delete, while it can still be taken back. The server holds the
  // record (and its file) for a few seconds and tells us how many; this is only
  // the offer. Module-level so it survives the repaint the delete itself causes.
  let undoable = null;          // { id, name, until }
  let undoTimer = 0;


  function maxBytes() {
    // From the server's own state, not from settings: `fileTransfer` is
    // server-owned and the phone never receives the block, so the list payload
    // is the one place both surfaces learn the limit.
    return Number(held.state.maxBytes) || (Number(settings().maxFileMb || 2048) * 1024 * 1024);
  }

  // ── sending ────────────────────────────────────────────────────────────────

  // iOS hands back every photo picked from the library as `image.jpg`, so a
  // batch of six arrives as six files with one name. The server keeps its own
  // unique name on disk either way; this is so the LIST is readable and so the
  // copy in the user's folder does not become "image (5).jpg".
  const GENERIC_NAME = /^(image|video|photo)\.(jpe?g|png|heic|mov|mp4)$/i;
  function proposeName(file, index) {
    const raw = String(file.name || '');
    if (raw && !GENERIC_NAME.test(raw)) return raw;
    const d = new Date(file.lastModified || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const ext = raw.includes('.') ? raw.slice(raw.lastIndexOf('.')) : '';
    return `${t('xfer_name_photo', 'Foto')}-${stamp}-${index + 1}${ext}`;
  }

  function enqueue(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const limit = maxBytes();
    let n = 0;
    for (const file of list) {
      const localId = 'l' + Math.random().toString(16).slice(2, 10);
      const name = proposeName(file, n++);
      // Checked here rather than by waiting for a 413: nobody should push a
      // 3 GB video over phone wifi to be told at the end that it was too big.
      if (file.size > limit) {
        // No retryFile: there is nothing to try again, the file is simply
        // larger than the PC accepts, and offering a button that cannot work
        // is worse than not offering one.
        localProgress.set(localId, { name, size: file.size, sent: 0, status: 'failed', error: 'too_big' });
        continue;
      }
      // The File itself is kept so Retry has something to send. It is a handle
      // to the file on disk, not its contents, so a queue of large videos costs
      // nothing to hold.
      localProgress.set(localId, { name, size: file.size, sent: 0, status: 'queued', error: '', retryFile: file });
      queue.push({ localId, file, name });
    }
    paint();
    pump();
  }

  // Strictly serial. Six parallel uploads on phone wifi make all six slow and
  // every progress bar meaningless, and one request per file keeps the count
  // trivial against the paired-device rate limit.
  function pump() {
    if (sendRun.sending) return;
    const job = queue.shift();
    if (!job) { sendRun.sending = false; sendRun.cancelled = false; return; }
    sendRun.sending = true;
    sendOne(job).then(() => { sendRun.sending = false; if (!sendRun.cancelled) pump(); else { queue.length = 0; sendRun.cancelled = false; paint(); } });
  }

  function sendOne(job) {
    return new Promise((resolve) => {
      const rec = localProgress.get(job.localId);
      if (rec) { rec.status = 'sending'; rec.sent = 0; }
      paint();
      const xhr = new XMLHttpRequest();
      sendRun.activeXhr = xhr;
      const url = server() + '/api/transfer/upload?name=' + encodeURIComponent(job.name);
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        const r = localProgress.get(job.localId);
        if (r && e.lengthComputable) { r.sent = e.loaded; paintProgressOnly(); }
      };
      xhr.onload = () => {
        sendRun.activeXhr = null;
        const r = localProgress.get(job.localId);
        let body = null;
        try { body = JSON.parse(xhr.responseText || '{}'); } catch { body = null; }
        if (xhr.status >= 200 && xhr.status < 300 && body && body.ok) {
          localProgress.delete(job.localId);   // the server's list now owns this row
        } else if (r) {
          r.status = 'failed';
          r.error = (body && body.error) || (xhr.status === 413 ? 'too_big' : (xhr.status === 507 ? 'no_space' : 'failed'));
          // An XHR bypasses the fetch wrapper in remote-surface.js, so a refusal
          // on the paired-device door would otherwise be explained nowhere.
          if (xhr.status === 403 && window.RemoteSurface && typeof window.RemoteSurface.explainDenied === 'function') {
            window.RemoteSurface.explainDenied('/api/transfer/upload');
          }
        }
        paint();
        resolve();
      };
      xhr.onerror = xhr.ontimeout = () => {
        sendRun.activeXhr = null;
        const r = localProgress.get(job.localId);
        if (r) { r.status = 'failed'; r.error = 'net'; }
        paint();
        resolve();
      };
      xhr.onabort = () => {
        sendRun.activeXhr = null;
        localProgress.delete(job.localId);
        paint();
        resolve();
      };
      xhr.send(job.file);
    });
  }

  function cancelAll() {
    sendRun.cancelled = true;
    queue.length = 0;
    for (const [id, r] of localProgress) if (r.status === 'queued') localProgress.delete(id);
    if (sendRun.activeXhr) { try { sendRun.activeXhr.abort(); } catch { /* already done */ } }
    paint();
  }

  function retry(localId) {
    const rec = localProgress.get(localId);
    if (!rec || !rec.retryFile) { localProgress.delete(localId); paint(); return; }
    rec.status = 'queued';
    rec.error = '';
    rec.sent = 0;
    queue.push({ localId, file: rec.retryFile, name: rec.name });
    paint();
    pump();
  }

  // ── receiving side actions ─────────────────────────────────────────────────

  async function act(path, id) {
    const out = await api(server() + '/api/transfer/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return out || { ok: false, error: 'net' };
  }

  async function openItem(item, row) {
    const out = await act('open', item.id);
    if (out.ok) return;
    if (out.error === 'blocked_ext' && out.revealable) {
      note(row, t('xfer_open_blocked', 'Questo file Xenon non lo apre. Puoi mostrarlo nella cartella.'));
      return;
    }
    note(row, t('xfer_open_failed', 'Non si è aperto.'));
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  const {
    ensure,
  } = window.TransferWidgetTileBody({ ICONS, iconBtn, pickBtn, enqueue, paint, wireDrop });

  function wireDrop(mount, zone) {
    let depth = 0;    // a counter, not a boolean: dragleave fires per child
    zone.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      zone.classList.add('is-hot');
    });
    zone.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();            // without this, `drop` never fires at all
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) zone.classList.remove('is-hot');
    });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      zone.classList.remove('is-hot');
      const dt = e.dataTransfer;
      // Folders are refused with a line rather than silently sending only the
      // loose files in the drop, which looks like it worked.
      let hadFolder = false;
      if (dt && dt.items) {
        for (const item of Array.from(dt.items)) {
          const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
          if (entry && entry.isDirectory) hadFolder = true;
        }
      }
      if (hadFolder) note(zone, t('xfer_no_folders', 'Le cartelle non si mandano. Aprila e scegli i file dentro.'));
      enqueue(dt ? dt.files : null);
    });
  }

  const { hasFiles, guardWindowDrops } = window.TransferWidgetWindowDrops;

  function rowFor(item) {
    const row = el('div', 'xfer-row');
    row.dataset.xferId = item.id;

    const shot = el('div', 'xfer-shot');
    const icon = el('div', 'xfer-thumb');
    if (item.thumb) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = server() + '/api/transfer/thumb?id=' + encodeURIComponent(item.id);
      // A HEIC that reached the PC untranscoded cannot be decoded by any
      // browser here. That is not a bug and must not render as a broken image.
      img.addEventListener('error', () => {
        icon.replaceChildren(el('span', 'xfer-ext', (item.ext || '?').replace('.', '').toUpperCase()));
      });
      icon.appendChild(img);
    } else {
      icon.replaceChildren(el('span', 'xfer-ext', (item.ext || '?').replace('.', '').toUpperCase()));
    }

    const from = item.direction === 'out'
      ? t('xfer_from_pc', 'dal PC')
      : (item.from ? t('xfer_from', 'da') + ' ' + item.from : '');

    // Which way it went, as a mark on the thumbnail rather than a word at the
    // end of the meta line. Direction is the first thing you scan a list like
    // this for, and it was arriving last, in the dimmest text in the row.
    const badge = el('span', 'xfer-dir ' + (item.direction === 'out' ? 'is-out' : 'is-in'));
    badge.innerHTML = item.direction === 'out' ? ICONS.up : ICONS.down;  // static SVG
    if (from) badge.title = from;
    shot.append(icon, badge);

    const body = el('div', 'xfer-body');
    const name = el('div', 'xfer-name', item.name);   // off the network: textContent
    name.title = item.name;
    const meta = el('div', 'xfer-meta', [formatBytes(item.size), fmtAge(item.at), from].filter(Boolean).join(', '));
    body.append(name, meta);

    const acts = el('div', 'xfer-row-acts');
    if (isRemote()) {
      // On a phone the intent is almost always "pull it onto this device";
      // "open" there would mean opening it on the PC in the other room.
      const dl = el('a', 'xfer-icon xfer-icon-primary');
      dl.href = server() + '/api/transfer/file?id=' + encodeURIComponent(item.id);
      dl.setAttribute('download', item.name);
      dl.title = t('xfer_download', 'Scarica');
      dl.innerHTML = ICONS.down;      // static, trusted SVG
      acts.append(dl);
    } else {
      acts.append(
        iconBtn(ICONS.open, t('xfer_open', 'Apri'), () => openItem(item, row)),
        iconBtn(ICONS.folder, t('xfer_reveal', 'Mostra nella cartella'), async () => {
          const out = await act('reveal', item.id);
          if (!out.ok) note(row, t('xfer_reveal_failed', 'Non l’ho trovato.'));
        }),
      );
    }
    acts.append(iconBtn(ICONS.trash, t('xfer_delete', 'Togli dall’elenco'), async () => {
      const out = await act('delete', item.id);
      if (!out.ok) { note(row, t('xfer_delete_failed', 'Non l’ho tolto.')); return; }
      offerUndo(item, Number(out.undoMs) || 0);
    }));

    row.append(shot, body, acts);
    return row;
  }

  // ── taking a delete back ───────────────────────────────────────────────────
  // The bin says "remove from the list", and with the copy into your own folder
  // turned off that list holds the only copy there is. Reported as "there is no
  // way back". One line, for as long as the server is still holding the file.
  function offerUndo(item, ms) {
    if (!(ms > 0)) return;
    clearTimeout(undoTimer);
    undoable = { id: item.id, name: item.name, until: Date.now() + ms };
    // A beat before the server's own window closes, so the offer is never still
    // on screen after the file is gone for good.
    undoTimer = setTimeout(() => { undoable = null; paint(); }, Math.max(0, ms - 400));
    paint();
  }

  function undoRow() {
    if (!undoable) return null;
    const row = el('div', 'xfer-undo');
    row.append(el('span', 'xfer-undo-txt',
      t('xfer_removed', 'Tolto dall’elenco:') + ' ' + undoable.name));
    const b = el('button', 'xfer-undo-btn', t('xfer_undo', 'Annulla'));
    b.type = 'button';
    b.addEventListener('click', async () => {
      const id = undoable && undoable.id;
      if (!id) return;
      b.disabled = true;
      const out = await act('undo', id);
      clearTimeout(undoTimer);
      undoable = null;
      // A refused undo means the window closed while the finger was moving.
      if (!out.ok && window.XenonToast) {
        window.XenonToast.show({ type: 'error', title: t('xfer_undo_late', 'Troppo tardi: quel file non c’è più.') });
      }
      paint();
    });
    row.append(b);
    return row;
  }

  function pickBtn(cls, svg, label) {
    const b = el('button', cls);
    b.type = 'button';
    const ic = el('span', 'xfer-btn-ic');
    ic.innerHTML = svg;               // static, trusted SVG
    b.append(ic, el('span', 'xfer-btn-label', label));
    return b;
  }

  function iconBtn(svg, title, onClick) {
    const b = el('button', 'xfer-icon');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = svg;                // static, trusted SVG
    b.addEventListener('click', onClick);
    return b;
  }

  function pendingRow(rec, localId) {
    const row = el('div', 'xfer-row is-pending');
    const icon = el('div', 'xfer-thumb');
    icon.innerHTML = ICONS.up;        // static, trusted SVG
    const body = el('div', 'xfer-body');
    body.append(el('div', 'xfer-name', rec.name));
    if (rec.status === 'failed') {
      const why = {
        too_big: t('xfer_failed_big', 'Troppo grande. Il limite è {max}.').replace('{max}', formatBytes(maxBytes())),
        no_space: t('xfer_failed_space', 'Sul PC non c’è più spazio.'),
        net: t('xfer_failed_net', 'Il PC non ha risposto.'),
        disabled: t('xfer_failed_off', 'Il trasferimento è spento.'),
      }[rec.error] || t('xfer_failed', 'Non è arrivato.');
      body.append(el('div', 'xfer-meta xfer-bad', why));
    } else {
      const pct = rec.size ? Math.min(100, Math.round((rec.sent / rec.size) * 100)) : 0;
      body.append(el('div', 'xfer-meta', pct + '%, ' + formatBytes(rec.size)));
      const bar = el('div', 'xfer-bar');
      const fill = el('div', 'xfer-bar-fill');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      body.appendChild(bar);
    }
    const acts = el('div', 'xfer-row-acts');
    if (rec.status === 'failed') {
      if (rec.retryFile) {
        const again = el('button', 'xfer-btn xfer-btn-retry', t('xfer_retry', 'Riprova'));
        again.type = 'button';
        again.addEventListener('click', () => retry(localId));
        acts.append(again);
      }
      acts.append(iconBtn(ICONS.close, t('xfer_dismiss', 'Chiudi'), () => { localProgress.delete(localId); paint(); }));
    } else if (rec.status === 'sending' || rec.status === 'queued') {
      acts.append(iconBtn(ICONS.close, t('xfer_cancel', 'Annulla'), cancelAll));
    }
    row.append(icon, body, acts);
    return row;
  }

  // Progress-only repaint: rewriting the whole list sixty times a second while
  // a video uploads would drop every open menu and thrash the layout.
  function paintProgressOnly() {
    for (const tile of tiles().concat(sheetHold.sheet ? [sheetHold.sheet] : [])) {
      const mount = tile.querySelector ? (tile.querySelector('.transfer-widget-mount') || tile) : tile;
      for (const [id, rec] of localProgress) {
        const fill = mount.querySelector(`[data-xfer-local="${id}"] .xfer-bar-fill`);
        if (fill && rec.size) fill.style.width = Math.min(100, Math.round((rec.sent / rec.size) * 100)) + '%';
      }
    }
  }

  function paintInto(mount) {
    ensure(mount);
    const usage = mount.querySelector('.xfer-usage');
    const list = mount.querySelector('.xfer-list');
    if (!list) return;

    if (usage) {
      // A pill with nothing in it is a smudge, so it goes away entirely rather
      // than rendering as an empty capsule.
      usage.textContent = held.state.bytes ? formatBytes(held.state.bytes) : '';
      usage.hidden = !held.state.bytes;
    }

    const rows = [];
    // First, so the offer is where the row that vanished used to be rather than
    // at the bottom of a long list.
    const undo = undoRow();
    if (undo) rows.push(undo);
    for (const [id, rec] of localProgress) {
      const r = pendingRow(rec, id);
      r.dataset.xferLocal = id;
      rows.push(r);
    }
    // Uploads happening on ANOTHER surface, from the server's own view.
    for (const p of held.state.pending || []) {
      const rec = { name: p.name, size: p.total || 0, sent: p.received || 0, status: 'sending', error: '' };
      rows.push(pendingRow(rec, p.id));
    }
    for (const item of held.state.items || []) rows.push(rowFor(item));
    list.replaceChildren(...rows);

    // The drop panel never hides — it is where files come in, whether or not
    // any have arrived yet. Only its line changes, and only to say that iOS is
    // still exporting a video and has not gone silent on us.
    const drop = mount.querySelector('.xfer-drop');
    const text = drop && drop.querySelector('.xfer-drop-text');
    if (text) {
      text.textContent = mount.dataset.xferPreparing === '1'
        ? t('xfer_preparing', 'Preparo i file. Su iPhone un video lungo ci mette un po’.')
        : (isRemote()
          ? t('xfer_empty_body_phone', 'Tocca Foto e video e scegli cosa mandare al PC.')
          : t('xfer_empty_body', 'Trascina qui dei file, o mandali dal telefono.'));
    }
    // Compact once there is a list to keep room for: the glyph and the hint are
    // an invitation, and an invitation only needs to shout on an empty tile.
    if (drop) drop.classList.toggle('is-compact', rows.length > 0);
  }

  function paint() {
    for (const tile of tiles()) {
      const mount = tile.querySelector('.transfer-widget-mount');
      if (mount) paintInto(mount);
    }
    if (sheetHold.sheet) paintInto(sheetHold.sheet.querySelector('.transfer-widget-mount'));
  }

  const { openSheet } = window.TransferWidgetPhoneSheet({ ICONS, iconBtn, paintInto, refresh });

  window.addEventListener('popstate', onBack);

  // ── wiring ─────────────────────────────────────────────────────────────────

  async function refresh() {
    const out = await api(server() + '/api/transfer/list');
    if (out && out.ok) { held.state = out; held.seeded = true; paint(); }
  }

  function onState(data) {
    if (!data || typeof data !== 'object') return;
    held.state = {
      enabled: data.enabled !== false,
      items: Array.isArray(data.items) ? data.items : [],
      pending: Array.isArray(data.pending) ? data.pending : [],
      bytes: Number(data.bytes) || 0,
      quotaBytes: Number(data.quotaBytes) || 0,
      maxBytes: Number(data.maxBytes) || 0,
    };
    held.seeded = true;
    paint();
    syncDock();
  }

  function onProgress(data) {
    if (!data || !data.id) return;
    const p = (held.state.pending || []).find((x) => x.id === data.id);
    if (p) { p.received = Number(data.received) || 0; p.total = Number(data.total) || p.total; }
    if (data.done) return;           // the following `transfer` frame owns the list
    paintProgressOnly();
  }

  function syncDock() {
    if (!window.PhoneView || typeof window.PhoneView.addDockAction !== 'function') return;
    const on = held.state.enabled !== false && settings().enabled !== false;
    window.PhoneView.addDockAction({
      id: 'transfer',
      // The dock has no button of ours to copy an icon from, so it gets a path
      // in the same 24x24 box the topbar icons use. `glyph` stays as the
      // fallback for a surface where the SVG cannot be built.
      icon: 'M12 2.6 18 8.6 16.2 10.4 13.3 7.5 13.3 16 10.7 16 10.7 7.5 7.8 10.4 6 8.6 12 2.6ZM5 18 19 18 19 20.4 5 20.4Z',
      glyph: '⇪',
      key: 'xfer_dock',
      short: 'ph_send',
      run: openSheet,
      remove: !on,
    });
  }

  function renderWidgets() {
    syncDock();
    if (!tiles().length && !sheetHold.sheet) return;
    paint();
    if (!held.seeded) { held.seeded = true; refresh(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', guardWindowDrops, { once: true });
  else guardWindowDrops();

  // ── Settings → Telefono ────────────────────────────────────────────────────
  async function initSettings() {
    const box = document.getElementById('settings-transfer');
    if (!box) return;
    setup.settingsBox = box;
    if (isRemote()) {
      // Rather than spend a request to be told no. The panel is not hidden —
      // saying where it lives is more useful than pretending it does not exist.
      const page = sectionPage();
      page.append(el('p', 'settings-note', t('xfer_settings_pc_only', 'La cartella di arrivo si sceglie dal PC.')));
      box.replaceChildren(page);
      return;
    }
    const out = await api(server() + '/api/transfer/settings');
    if (!out || !out.ok) return;
    setup.cfg = out;
    // pushState() is async (it asks the service worker), so it is resolved here
    // rather than read inside the render — a sync read of a promise is always
    // truthy and would have shown the toggle on every machine.
    try {
      if (window.Pwa && typeof window.Pwa.pushState === 'function') setup.pushInfo = await window.Pwa.pushState();
    } catch { /* no service worker here */ }
    renderSettings();
  }

  async function saveSettings(patch) {
    const out = await api(server() + '/api/transfer/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (out && out.ok) { setup.cfg = { ...setup.cfg, ...out }; return { ok: true }; }
    return { ok: false, error: (out && out.error) || 'failed' };
  }

  const {
    renderSettings,
  } = window.TransferWidgetSettingsPage({ saveSettings, syncDock, pickedFolderField, typedFolderField });

  // Where the capture engine runs (Windows), the folder comes from the
  // system's own folder dialog, the same one Settings → Recording uses: no
  // path to type, and the server checks the answer like a typed one.
  function pickedFolderField() {
    const field = el('div', 'settings-row xfer-set-field');
    const shown = el('span', 'settings-hint xfer-set-path', setup.cfg.inboxDir || '');
    const status = el('div', 'xfer-set-status');
    const pick = el('button', 'settings-btn', t('settings_capture_pick', 'Cambia'));
    pick.type = 'button';
    const reset = el('button', 'settings-btn', t('xfer_settings_folder_default', 'Torna a Download'));
    reset.type = 'button';
    const sync = () => {
      shown.textContent = setup.cfg.inboxDir || '';
      reset.hidden = !setup.cfg.inboxDir || setup.cfg.inboxDir === setup.cfg.inboxDefault;
    };
    sync();

    pick.addEventListener('click', async () => {
      pick.disabled = true;
      status.textContent = '';
      status.className = 'xfer-set-status';
      const out = await api(server() + '/api/transfer/settings/pick', { method: 'POST' });
      pick.disabled = false;
      if (out && out.ok && out.cancelled) return;
      if (out && out.ok) {
        setup.cfg = { ...setup.cfg, ...out };
        sync();
        status.textContent = t('settings_saved', 'Salvato');
        status.className = 'xfer-set-status is-ok';
        return;
      }
      status.className = 'xfer-set-status is-bad';
      status.textContent = folderError(out && out.error);
    });
    reset.addEventListener('click', async () => {
      const res = await saveSettings({ inboxDir: '' });
      if (res.ok) { status.textContent = ''; status.className = 'xfer-set-status'; sync(); }
    });

    const actions = el('div', 'xfer-set-actions');
    actions.append(pick, reset);
    field.append(folderName(shown), actions, status, folderHint());
    return field;
  }

  function typedFolderField() {
    const field = el('div', 'settings-row xfer-set-field');
    // A text field rather than a native directory picker: a browser's folder
    // picker returns a file list, not a path, and Xenon needs the path. The
    // server validates it and refuses anything inside its own directories.
    //
    // The field IS the current value; there is no read-only copy of the same
    // path above it. Showing both meant the panel opened with the same string
    // printed twice, which reads as a bug rather than as confirmation.
    const edit = document.createElement('input');
    edit.type = 'text';
    edit.className = 'settings-text-input xfer-set-input';
    edit.value = setup.cfg.inboxDir || '';
    edit.spellcheck = false;
    edit.setAttribute('aria-label', t('xfer_settings_folder', 'Cartella di arrivo'));

    const status = el('div', 'xfer-set-status');
    const apply = el('button', 'settings-btn', t('xfer_settings_folder_save', 'Usa questa cartella'));
    apply.type = 'button';
    const reset = el('button', 'settings-btn', t('xfer_settings_folder_default', 'Torna a Download'));
    reset.type = 'button';

    // Save is live only while the field differs from what is stored, so the
    // panel says at a glance whether there is an unsaved edit sitting in it.
    const sync = () => { apply.disabled = edit.value.trim() === (setup.cfg.inboxDir || ''); };
    sync();
    edit.addEventListener('input', () => { status.textContent = ''; status.className = 'xfer-set-status'; sync(); });

    apply.addEventListener('click', async () => {
      const res = await saveSettings({ inboxDir: edit.value.trim() });
      if (res.ok) {
        edit.value = setup.cfg.inboxDir || '';
        status.textContent = t('settings_saved', 'Salvato');
        status.className = 'xfer-set-status is-ok';
      } else {
        status.className = 'xfer-set-status is-bad';
        status.textContent = folderError(res.error);
      }
      sync();
    });
    reset.addEventListener('click', async () => {
      const res = await saveSettings({ inboxDir: '' });
      if (res.ok) { edit.value = setup.cfg.inboxDir || ''; status.textContent = ''; status.className = 'xfer-set-status'; sync(); }
    });

    const actions = el('div', 'xfer-set-actions');
    actions.append(apply, reset);
    field.append(folderName(), edit, actions, status, folderHint());
    return field;
  }

  window.TransferWidget = {
    renderWidgets, onState, onProgress, openSheet, refresh, enqueue, cancelAll, retry, initSettings,
  };
})();
