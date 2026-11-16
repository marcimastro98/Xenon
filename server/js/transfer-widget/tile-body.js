// The transfer tile as it is first built: its head with the help key, the drop panel with the two
// pickers, and the list; and the line it shows while iOS is still exporting a video.
'use strict';

window.TransferWidgetTileBody = (wrapper) => {
  const { ICONS, iconBtn, pickBtn, enqueue, paint, wireDrop } = wrapper;

  const { t, el, helpPanel } = window.TransferWidgetSays;
  const { toggleHelp } = window.TransferWidgetSheetSteps;

  function ensure(mount) {
    if (mount.dataset.xferBuilt === '1' && mount.firstChild) return;
    mount.dataset.xferBuilt = '1';
    mount.replaceChildren();

    const head = el('div', 'xfer-head');
    const title = el('div', 'xfer-title', t('xfer_title', 'Trasferimento file'));
    const usage = el('div', 'xfer-usage');
    // The tile said "or send them from your phone" and never said HOW — the
    // steps were in FEATURES.md and in nobody's dashboard. Asked for on
    // Discord. It is a button rather than four permanent lines of instructions
    // because a tile you have used once should be a list of files, not a manual.
    const help = iconBtn(ICONS.help, t('xfer_help', 'Come funziona'), () => toggleHelp(mount));
    help.classList.add('xfer-help-btn');
    help.setAttribute('aria-expanded', 'false');
    head.append(title, help, usage);

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
    // Driven by the two keys: in the Tab order they would be two invisible stops.
    inPhotos.tabIndex = -1;
    inFiles.tabIndex = -1;

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
    // The panel goes INSIDE the zone, as an overlay over it. Above the zone it
    // was a block in the same column flex, so opening it squeezed the list to
    // nothing on any tile that was not very tall — the help arrived and the
    // files left. Over the zone, one thing is on screen at a time and closing
    // it gives back exactly what was there.
    zone.append(list, drop, helpPanel());
    mount.append(head, zone, inPhotos, inFiles);
    wireDrop(mount, zone);
  }

  // ── "how does this work" ───────────────────────────────────────────────────
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

  return { ensure };
};
