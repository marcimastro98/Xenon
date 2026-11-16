// The phone sheet of the transfer tile: the panel that rises from the bottom edge with the tile
// inside it, and the pull on its bar that closes it.
'use strict';

window.TransferWidgetPhoneSheet = (wrapper) => {
  const { ICONS, iconBtn, paintInto, refresh } = wrapper;

  const { t, el, sheetNotes } = window.TransferWidgetSays;
  const { held } = window.TransferWidgetKnown;
  const {
    sheetHold, toggleHelp, PULL_CLOSE_SHARE, PULL_FLICK, PULL_FLICK_MIN, PULL_FLICK_FRESH, closeSheet,
    markHistory, stepBack,
  } = window.TransferWidgetSheetSteps;

  // ── the phone sheet ────────────────────────────────────────────────────────

  function openSheet() {
    if (sheetHold.sheet) return;
    const backdrop = el('div', 'xfer-sheet-backdrop');
    const panel = el('div', 'xfer-sheet');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', t('xfer_send', 'Invia al PC'));
    panel.tabIndex = -1;
    const bar = el('div', 'xfer-sheet-bar');
    const title = el('div', 'xfer-sheet-title', t('xfer_send', 'Invia al PC'));
    // The sheet hides the tile's own header (CSS), so the ? lives here. It
    // drives the SAME panel inside the mount — one text, two doors.
    const help = iconBtn(ICONS.help, t('xfer_help', 'Come funziona'),
      () => toggleHelp(panel.querySelector('.transfer-widget-mount')));
    help.classList.add('xfer-help-btn');
    help.setAttribute('aria-expanded', 'false');
    const close = iconBtn(ICONS.close, t('xfer_close', 'Chiudi'), () => closeSheet());
    bar.append(title, help, close);
    const mount = el('div', 'transfer-widget-mount');
    const notes = el('div', 'xfer-notes');
    for (const line of sheetNotes()) notes.append(el('p', 'xfer-note-line', line));
    const body = el('div', 'xfer-sheet-body');
    body.append(mount, notes);
    const foot = el('div', 'xfer-sheet-foot');
    panel.append(bar, body, foot);
    backdrop.appendChild(panel);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    document.body.appendChild(backdrop);
    sheetHold.sheet = backdrop;
    // Nothing paints under a frosted overlay. The token is PER INSTANCE, the
    // preset-share shape: a shared one left the dashboard frozen when a dialog
    // reopened inside the previous one's close timer.
    sheetHold.sheet._freezeToken = 'xfer-sheet-' + Math.random().toString(16).slice(2, 8);
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze(sheetHold.sheet._freezeToken, true);
    paintInto(mount);
    // The two keys leave the panel for the foot, the main one last, as on every sheet.
    // The tile keeps them where they are.
    const keys = mount.querySelector('.xfer-actions');
    keys.append(keys.querySelector('.xfer-btn-primary'));
    foot.append(keys);
    sheetHold.sheet._letGo = window.DialogFocus.hold(panel, { onEsc: stepBack });
    armPull(panel, bar);
    markHistory();
    if (!held.seeded) refresh();
  }

  function armPull(panel, bar) {
    let pull = null;
    bar.addEventListener('pointerdown', (e) => {
      if ((e.button != null && e.button !== 0) || e.target.closest('button')) return;
      if (!window.matchMedia || !window.matchMedia('(max-width: 699.98px)').matches) return;
      pull = { y: e.clientY, dy: 0, at: Date.now(), speed: 0 };
      panel.classList.add('is-pulled');
      try { bar.setPointerCapture(e.pointerId); } catch { /* older engine */ }
    });
    bar.addEventListener('pointermove', (e) => {
      if (!pull) return;
      const dy = Math.max(0, e.clientY - pull.y);
      const now = Date.now();
      pull.speed = (dy - pull.dy) / Math.max(1, now - pull.at);
      pull.dy = dy;
      pull.at = now;
      panel.style.setProperty('--xfer-pull', dy + 'px');
    });
    const letGo = (canClose) => {
      if (!pull) return;
      const { dy } = pull;
      const speed = Date.now() - pull.at > PULL_FLICK_FRESH ? 0 : pull.speed;
      pull = null;
      panel.classList.remove('is-pulled');
      const tall = panel.getBoundingClientRect().height || 400;
      if (canClose && (dy > tall * PULL_CLOSE_SHARE || (dy > PULL_FLICK_MIN && speed > PULL_FLICK))) { closeSheet(); return; }
      panel.style.removeProperty('--xfer-pull');
    };
    bar.addEventListener('pointerup', () => letGo(true));
    // The system took the finger (a scroll, a call): the sheet goes back, never away.
    bar.addEventListener('pointercancel', () => letGo(false));
  }

  return { openSheet };
};
