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
  };

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;
  const api = apiJson;
  const server = () => (typeof SERVER === 'string' ? SERVER : '');

  // Server truth, replaced wholesale by every `transfer` SSE frame. A whole-list
  // push rather than a delta: a surface that reconnects is then correct with no
  // replay to reason about, the shape notes and tasks already use.
  let state = { enabled: true, items: [], pending: [], bytes: 0, quotaBytes: 0, maxBytes: 0 };
  let seeded = false;
  // Live upload progress for the rows THIS surface is sending. The server's own
  // counter is ahead of the network (kernel socket buffers), so the sender
  // trusts its own numbers and the SSE frames are for everybody else.
  const localProgress = new Map();   // localId -> { name, size, sent, status, error }
  const queue = [];
  let sending = false;
  let cancelled = false;
  let activeXhr = null;
  let sheet = null;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="transfer"]'))
      .filter((n) => n.closest('.pager-page'));
  }
  const isRemote = () => !!(typeof window !== 'undefined' && window.__xenonRemote);
  const onPhone = () => !!(window.PhoneView && window.PhoneView.isActive());

  function settings() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.fileTransfer : null;
    return (hs && typeof hs === 'object') ? hs : {};
  }

  function maxBytes() {
    // From the server's own state, not from settings: `fileTransfer` is
    // server-owned and the phone never receives the block, so the list payload
    // is the one place both surfaces learn the limit.
    return Number(state.maxBytes) || (Number(settings().maxFileMb || 2048) * 1024 * 1024);
  }

  function fmtAge(at) {
    const s = Math.max(0, Math.floor((Date.now() - (at || 0)) / 1000));
    if (s < 60) return t('xfer_now', 'ora');
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    return Math.floor(s / 86400) + ' g';
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
    if (sending) return;
    const job = queue.shift();
    if (!job) { sending = false; cancelled = false; return; }
    sending = true;
    sendOne(job).then(() => { sending = false; if (!cancelled) pump(); else { queue.length = 0; cancelled = false; paint(); } });
  }

  function sendOne(job) {
    return new Promise((resolve) => {
      const rec = localProgress.get(job.localId);
      if (rec) { rec.status = 'sending'; rec.sent = 0; }
      paint();
      const xhr = new XMLHttpRequest();
      activeXhr = xhr;
      const url = server() + '/api/transfer/upload?name=' + encodeURIComponent(job.name);
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        const r = localProgress.get(job.localId);
        if (r && e.lengthComputable) { r.sent = e.loaded; paintProgressOnly(); }
      };
      xhr.onload = () => {
        activeXhr = null;
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
        activeXhr = null;
        const r = localProgress.get(job.localId);
        if (r) { r.status = 'failed'; r.error = 'net'; }
        paint();
        resolve();
      };
      xhr.onabort = () => {
        activeXhr = null;
        localProgress.delete(job.localId);
        paint();
        resolve();
      };
      xhr.send(job.file);
    });
  }

  function cancelAll() {
    cancelled = true;
    queue.length = 0;
    for (const [id, r] of localProgress) if (r.status === 'queued') localProgress.delete(id);
    if (activeXhr) { try { activeXhr.abort(); } catch { /* already done */ } }
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

  function note(row, text) {
    if (!row) {
      if (window.XenonToast && typeof window.XenonToast.show === 'function') {
        window.XenonToast.show({ type: 'warn', title: t('xfer_title', 'Trasferimento file'), message: text });
      }
      return;
    }
    let n = row.querySelector('.xfer-note');
    if (!n) { n = el('div', 'xfer-note'); row.appendChild(n); }
    n.textContent = text;
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  function ensure(mount) {
    if (mount.dataset.xferBuilt === '1' && mount.firstChild) return;
    mount.dataset.xferBuilt = '1';
    mount.replaceChildren();

    const head = el('div', 'xfer-head');
    const title = el('div', 'xfer-title', t('xfer_title', 'Trasferimento file'));
    const usage = el('div', 'xfer-usage');
    head.append(title, usage);

    const zone = el('div', 'xfer-zone');
    const actions = el('div', 'xfer-actions');
    // Each button carries the icon of what it opens. Two plain words side by
    // side read as a pair of tabs, which is what they looked like: nothing said
    // they add files, and a control whose job you have to guess is a control
    // people do not press.
    const bPhotos = pickBtn('xfer-btn xfer-btn-primary', ICONS.photo, t('xfer_pick_photos', 'Foto e video'));
    const bFiles = pickBtn('xfer-btn', ICONS.file, t('xfer_pick_files', 'Altri file'));
    actions.append(bPhotos, bFiles);

    // TWO inputs, never one. A single `accept` greys out perfectly ordinary
    // files on Android (the system reports application/octet-stream for plenty
    // of them, with no explanation shown), and on iOS `accept="image/*"`
    // removes "Choose File" and with it iCloud Drive. `capture` is never used:
    // it forces the camera and removes the library entirely.
    const inPhotos = document.createElement('input');
    inPhotos.type = 'file';
    inPhotos.multiple = true;
    inPhotos.accept = 'image/*,video/*';
    inPhotos.className = 'xfer-input';
    const inFiles = document.createElement('input');
    inFiles.type = 'file';
    inFiles.multiple = true;
    inFiles.className = 'xfer-input';

    for (const [btn, input] of [[bPhotos, inPhotos], [bFiles, inFiles]]) {
      btn.addEventListener('click', () => { armPreparing(mount); input.click(); });
      input.addEventListener('change', () => {
        clearPreparing(mount);
        enqueue(input.files);
        input.value = '';           // so picking the same file twice still fires
      });
    }

    // ONE panel does the drop hint and holds the pickers, and it is ALWAYS on
    // screen. Two earlier shapes were both wrong for the same reason: a dashed
    // area that appeared only when the list was empty meant a tile with files
    // in it never said you could drop, and buttons on their own line below a
    // blank region did not say they were about adding files either. Put inside
    // the drop panel, the two answer each other: this is where files come in,
    // by dragging or by picking.
    const drop = el('div', 'xfer-drop');
    const glyph = el('div', 'xfer-drop-glyph');
    glyph.innerHTML = ICONS.up;         // static, trusted SVG
    const dropInner = el('div', 'xfer-drop-inner');
    dropInner.append(glyph, el('p', 'xfer-drop-text'), actions);
    drop.append(dropInner);

    const list = el('div', 'xfer-list');

    // The list takes the height it needs and the drop panel absorbs whatever is
    // left, so a tall tile has no dead region under the last row — the leftover
    // space belongs to the thing the space is for. With many files it is the
    // list that grows and the panel falls back to its minimum.
    zone.append(list, drop);
    mount.append(head, zone, inPhotos, inFiles);
    wireDrop(mount, zone);
  }

  // iOS does not fire `change` until it has finished exporting a video, which
  // for a long 4K clip is the better part of a minute of complete silence. Say
  // what is happening instead of looking dead.
  function armPreparing(mount) {
    if (!/iP(hone|ad|od)/.test(navigator.userAgent)) return;
    mount.dataset.xferPreparing = '1';
    clearTimeout(mount._xferPrepTimer);
    mount._xferPrepTimer = setTimeout(() => clearPreparing(mount), 90000);
    paint();
  }
  function clearPreparing(mount) {
    delete mount.dataset.xferPreparing;
    clearTimeout(mount._xferPrepTimer);
    paint();
  }

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

  function hasFiles(e) {
    const types = e && e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
  }

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
    const meta = el('div', 'xfer-meta', [formatBytes(item.size), fmtAge(item.at), from].filter(Boolean).join(' · '));
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
      await act('delete', item.id);
    }));

    row.append(shot, body, acts);
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
      body.append(el('div', 'xfer-meta', pct + '% · ' + formatBytes(rec.size)));
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
    for (const tile of tiles().concat(sheet ? [sheet] : [])) {
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
      usage.textContent = state.bytes ? formatBytes(state.bytes) : '';
      usage.hidden = !state.bytes;
    }

    const rows = [];
    for (const [id, rec] of localProgress) {
      const r = pendingRow(rec, id);
      r.dataset.xferLocal = id;
      rows.push(r);
    }
    // Uploads happening on ANOTHER surface, from the server's own view.
    for (const p of state.pending || []) {
      const rec = { name: p.name, size: p.total || 0, sent: p.received || 0, status: 'sending', error: '' };
      rows.push(pendingRow(rec, p.id));
    }
    for (const item of state.items || []) rows.push(rowFor(item));
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
    if (sheet) paintInto(sheet.querySelector('.transfer-widget-mount'));
  }

  // ── the phone sheet ────────────────────────────────────────────────────────

  function openSheet() {
    if (sheet) return;
    const backdrop = el('div', 'xfer-sheet-backdrop');
    const panel = el('div', 'xfer-sheet');
    const bar = el('div', 'xfer-sheet-bar');
    const title = el('div', 'xfer-sheet-title', t('xfer_send', 'Invia al PC'));
    const close = iconBtn(ICONS.close, t('xfer_close', 'Chiudi'), closeSheet);
    bar.append(title, close);
    const mount = el('div', 'transfer-widget-mount');
    const notes = el('div', 'xfer-notes');
    for (const line of sheetNotes()) notes.append(el('p', 'xfer-note-line', line));
    panel.append(bar, mount, notes);
    backdrop.appendChild(panel);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    document.body.appendChild(backdrop);
    sheet = backdrop;
    // Nothing paints under a frosted overlay. The token is PER INSTANCE, the
    // preset-share shape: a shared one left the dashboard frozen when a dialog
    // reopened inside the previous one's close timer.
    sheet._freezeToken = 'xfer-sheet-' + Math.random().toString(16).slice(2, 8);
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze(sheet._freezeToken, true);
    paintInto(mount);
    if (!seeded) refresh();
  }

  function closeSheet() {
    if (!sheet) return;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze(sheet._freezeToken, false);
    sheet.remove();
    sheet = null;
  }

  // The boundaries, said where they would otherwise be discovered.
  function sheetNotes() {
    const out = [t('xfer_note_lan', 'Funziona quando il telefono e il PC sono sulla stessa rete, o su Tailscale.')];
    if (/iP(hone|ad|od)/.test(navigator.userAgent)) {
      // Not a shortcoming of Xenon and not fixable from a web page: WebKit does
      // not implement Web Share Target at all.
      out.push(t('xfer_note_ios', 'Su iPhone devi aprire Xenon per mandare qualcosa. Il tasto Condividi di iOS non può mandare a Xenon.'));
      out.push(t('xfer_note_ios_save', 'Un file scaricato va in File, non nel rullino. Per una foto, tienila premuta e scegli Aggiungi a Foto.'));
    }
    out.push(t('xfer_note_limits', 'Un file alla volta, uno dopo l’altro. Se chiudi Xenon a metà, quel file riparte da capo.'));
    return out;
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  async function refresh() {
    const out = await api(server() + '/api/transfer/list');
    if (out && out.ok) { state = out; seeded = true; paint(); }
  }

  function onState(data) {
    if (!data || typeof data !== 'object') return;
    state = {
      enabled: data.enabled !== false,
      items: Array.isArray(data.items) ? data.items : [],
      pending: Array.isArray(data.pending) ? data.pending : [],
      bytes: Number(data.bytes) || 0,
      quotaBytes: Number(data.quotaBytes) || 0,
      maxBytes: Number(data.maxBytes) || 0,
    };
    seeded = true;
    paint();
    syncDock();
  }

  function onProgress(data) {
    if (!data || !data.id) return;
    const p = (state.pending || []).find((x) => x.id === data.id);
    if (p) { p.received = Number(data.received) || 0; p.total = Number(data.total) || p.total; }
    if (data.done) return;           // the following `transfer` frame owns the list
    paintProgressOnly();
  }

  function syncDock() {
    if (!window.PhoneView || typeof window.PhoneView.addDockAction !== 'function') return;
    const on = state.enabled !== false && settings().enabled !== false;
    window.PhoneView.addDockAction({
      id: 'transfer',
      glyph: '⇪',
      key: 'xfer_dock',
      run: openSheet,
      remove: !on,
    });
  }

  function renderWidgets() {
    syncDock();
    if (!tiles().length && !sheet) return;
    paint();
    if (!seeded) { seeded = true; refresh(); }
  }

  // A file dropped ANYWHERE else replaces the whole dashboard with that file —
  // the browser navigates to it. Prevented only for drags that carry files, so
  // GridStack's own drag in layout-edit mode is untouched.
  function guardWindowDrops() {
    for (const type of ['dragover', 'drop']) {
      document.addEventListener(type, (e) => {
        if (!hasFiles(e)) return;
        if (e.target && e.target.closest && e.target.closest('.xfer-zone')) return;
        e.preventDefault();
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', guardWindowDrops, { once: true });
  else guardWindowDrops();

  // ── Settings → Telefono ────────────────────────────────────────────────────
  // Rendered in JS into an empty div, the shape remote-access-page.js uses. It
  // reads and writes /api/transfer/settings, which is loopback-only: the folder
  // is a path on THIS PC, so it is not in the settings blob a phone receives
  // and cannot be edited from one.
  //
  // The markup deliberately reuses the `.ra-*` classes of the device list this
  // block sits directly under, rather than growing a second vocabulary for the
  // same controls. RemoteAccessSettings.css says why in its own header: the two
  // are one scroll and must not read as two different products. Without the
  // `.ra-page` column the block also inherited the settings pane's full width,
  // so its text ran the whole way across a 4K screen while the panel above it
  // stayed in a 560px column.
  let cfg = null;
  let settingsBox = null;
  let pushInfo = { supported: false, secure: false };

  async function initSettings() {
    const box = document.getElementById('settings-transfer');
    if (!box) return;
    settingsBox = box;
    if (isRemote()) {
      // Rather than spend a request to be told no. The panel is not hidden —
      // saying where it lives is more useful than pretending it does not exist.
      const page = el('div', 'ra-page xfer-page');
      page.append(sectionHead(), el('p', 'ra-toggle-hint', t('xfer_settings_pc_only', 'La cartella di arrivo si sceglie dal PC.')));
      box.replaceChildren(page);
      return;
    }
    const out = await api(server() + '/api/transfer/settings');
    if (!out || !out.ok) return;
    cfg = out;
    // pushState() is async (it asks the service worker), so it is resolved here
    // rather than read inside the render — a sync read of a promise is always
    // truthy and would have shown the toggle on every machine.
    try {
      if (window.Pwa && typeof window.Pwa.pushState === 'function') pushInfo = await window.Pwa.pushState();
    } catch { /* no service worker here */ }
    renderSettings();
  }

  function sectionHead() {
    const head = el('div', 'ra-head');
    const row = el('div', 'ra-title-row');
    row.append(el('h3', 'ra-title', t('xfer_settings_title', 'Trasferimento file')));
    head.append(row, el('p', 'ra-sub', t('xfer_settings_intro',
      'Manda foto e file dal telefono a questo PC, e da questo PC al telefono. I file passano dalla tua rete, non da internet.')));
    return head;
  }

  async function saveSettings(patch) {
    const out = await api(server() + '/api/transfer/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (out && out.ok) { cfg = { ...cfg, ...out }; return { ok: true }; }
    return { ok: false, error: (out && out.error) || 'failed' };
  }

  function renderSettings() {
    if (!settingsBox || !cfg) return;
    const page = el('div', 'ra-page xfer-page');
    page.append(sectionHead());

    page.append(toggleRow('enabled', t('xfer_settings_enabled', 'Attiva il trasferimento file'),
      t('xfer_settings_enabled_hint', 'Da spento, il riquadro e il tasto sul telefono spariscono.')));

    // Everything below is governed by that switch, and follows it off screen.
    // A folder field belonging to a feature that is not running is a control
    // that asks to be filled in and then does nothing — the same reason the
    // device list above hides its own body when access is off.
    if (cfg.enabled !== false) {
      page.append(folderGroup());

      // Hidden entirely rather than shown broken: a toggle that cannot work is
      // worse than an absent one. Push needs the HTTPS door AND a phone that
      // has already been given notification permission.
      if (pushInfo && pushInfo.supported && pushInfo.secure) {
        page.append(toggleRow('notifyPhone', t('xfer_settings_notify', 'Avvisa il telefono quando c’è un file'),
          t('xfer_settings_notify_hint', 'Solo per i file che metti qui dal PC. L’avviso non contiene il nome del file.')));
      }

      page.append(el('p', 'ra-sub xfer-set-foot', t('xfer_settings_devices',
        'Possono mandare file i telefoni e i tablet che hai già associato qui sopra. Per fermarne uno, rimuovilo dall’elenco.')));
    }

    settingsBox.replaceChildren(page);
  }

  // The arrival folder: where the copy goes, and whether a copy is made at all.
  // The two belong in one group because the second answers "and what is that
  // folder for" — split apart, the toggle read as an unrelated third setting.
  function folderGroup() {
    const group = el('div', 'xfer-set-group');
    group.append(el('div', 'ra-devices-title', t('xfer_settings_folder', 'Cartella di arrivo')));
    group.append(toggleRow('autoDeliver', t('xfer_settings_deliver', 'Copia i file in quella cartella'),
      t('xfer_settings_deliver_hint', 'Da spento i file restano solo nell’elenco di Xenon, e li apri o li salvi da lì.')));
    if (cfg.autoDeliver === false) return group;

    const field = el('div', 'xfer-set-field');
    // A text field rather than a native directory picker: a browser's folder
    // picker returns a file list, not a path, and Xenon needs the path. The
    // server validates it and refuses anything inside its own directories.
    //
    // The field IS the current value; there is no read-only copy of the same
    // path above it. Showing both meant the panel opened with the same string
    // printed twice, which reads as a bug rather than as confirmation.
    const edit = document.createElement('input');
    edit.type = 'text';
    edit.className = 'xfer-set-input';
    edit.value = cfg.inboxDir || '';
    edit.spellcheck = false;
    edit.setAttribute('aria-label', t('xfer_settings_folder', 'Cartella di arrivo'));

    const status = el('div', 'xfer-set-status');
    const apply = el('button', 'ra-btn primary small', t('xfer_settings_folder_save', 'Usa questa cartella'));
    apply.type = 'button';
    const reset = el('button', 'ra-btn ghost small', t('xfer_settings_folder_default', 'Torna a Download'));
    reset.type = 'button';

    // Save is live only while the field differs from what is stored, so the
    // panel says at a glance whether there is an unsaved edit sitting in it.
    const sync = () => { apply.disabled = edit.value.trim() === (cfg.inboxDir || ''); };
    sync();
    edit.addEventListener('input', () => { status.textContent = ''; status.className = 'xfer-set-status'; sync(); });

    apply.addEventListener('click', async () => {
      const res = await saveSettings({ inboxDir: edit.value.trim() });
      if (res.ok) {
        edit.value = cfg.inboxDir || '';
        status.textContent = t('settings_saved', 'Salvato');
        status.className = 'xfer-set-status is-ok';
      } else {
        status.className = 'xfer-set-status is-bad';
        status.textContent = {
          not_found: t('xfer_folder_not_found', 'Questa cartella non esiste.'),
          not_absolute: t('xfer_folder_not_absolute', 'Serve il percorso completo.'),
          not_a_dir: t('xfer_folder_not_a_dir', 'Questo non è una cartella.'),
          inside_data: t('xfer_folder_inside', 'Questa cartella è di Xenon. Scegline un’altra.'),
          inside_app: t('xfer_folder_inside', 'Questa cartella è di Xenon. Scegline un’altra.'),
          symlink: t('xfer_folder_symlink', 'Questo è un collegamento. Indica la cartella vera.'),
        }[res.error] || t('xfer_folder_failed', 'Non ho potuto usarla.');
      }
      sync();
    });
    reset.addEventListener('click', async () => {
      const res = await saveSettings({ inboxDir: '' });
      if (res.ok) { edit.value = cfg.inboxDir || ''; status.textContent = ''; status.className = 'xfer-set-status'; sync(); }
    });

    const actions = el('div', 'xfer-set-actions');
    actions.append(apply, reset);
    field.append(edit, actions, status, el('p', 'ra-toggle-hint', t('xfer_settings_folder_hint',
      'I file arrivano qui con il loro nome. Se un nome esiste già, Xenon aggiunge un numero e non sostituisce mai niente.')));
    group.append(field);
    return group;
  }

  // The same switch the device list above uses, down to the knob: two controls
  // that do the same kind of thing, one under the other, in one scroll.
  function toggleRow(key, labelText, hint) {
    const row = el('label', 'ra-toggle-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    // Default-off keys read `=== true`, default-on keys read `!== false`, the
    // same split normalizeFileTransfer uses on the server.
    input.checked = key === 'notifyPhone' ? cfg[key] === true : cfg[key] !== false;
    input.addEventListener('change', async () => {
      const res = await saveSettings({ [key]: input.checked });
      if (!res.ok) { input.checked = !input.checked; return; }
      if (key === 'enabled') syncDock();
      // Both of these decide what else is on screen, so the panel is redrawn
      // rather than left showing controls the new state does not have.
      if (key === 'enabled' || key === 'autoDeliver') renderSettings();
    });
    const text = el('span', 'ra-toggle-text');
    text.append(el('strong', null, labelText));
    if (hint) text.append(el('span', 'ra-toggle-hint', hint));
    row.append(input, el('span', 'ra-toggle-knob'), text);
    return row;
  }

  window.TransferWidget = {
    renderWidgets, onState, onProgress, openSheet, refresh, enqueue, cancelAll, retry, initSettings,
  };
})();
