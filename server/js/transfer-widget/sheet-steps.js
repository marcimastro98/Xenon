// How the phone sheet steps back: the help first, then the sheet, with the history entry it pushed
// and how far a pull must go to close it.
'use strict';

(() => {
  const sheetHold = {
    sheet: null,
  };
  const SHEET_MARK = 'xferSheet';

  // Toggled per surface, and never remembered: this is a thing you read once.
  // Every ? button on the same mount follows the panel, so the tile's and the
  // phone sheet's cannot disagree about whether it is open.
  function toggleHelp(mount, force) {
    const box = mount && mount.querySelector('.xfer-help');
    if (!box) return;
    const open = force == null ? box.hidden : !!force;
    box.hidden = !open;
    const root = mount.closest('.xfer-sheet') || mount.parentElement || mount;
    root.querySelectorAll('.xfer-help-btn').forEach((b) => {
      b.setAttribute('aria-expanded', String(open));
      b.classList.toggle('is-on', open);
    });
  }

  // Pulled down by its title bar, the sheet goes, as a phone's own sheets do. Only where it
  // stands on the bottom edge (the CSS breakpoint): the centred dialog has no edge to go to.
  const PULL_CLOSE_SHARE = 0.25;   // of the sheet's height
  const PULL_FLICK = 0.5;          // px per ms: a quick flick closes from a short pull
  const PULL_FLICK_MIN = 24;       // px: a tap that jitters is not a flick
  const PULL_FLICK_FRESH = 100;    // ms: a finger that stopped before lifting threw nothing

  // fromHistory: the phone's Back already popped our entry.
  function closeSheet(fromHistory = false) {
    if (!sheetHold.sheet) return;
    sheetHold.sheet._letGo();
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze(sheetHold.sheet._freezeToken, false);
    sheetHold.sheet.remove();
    sheetHold.sheet = null;
    if (!fromHistory && history.state && history.state[SHEET_MARK]) history.back();
  }

  // A phone's Back would leave the page: one step in the history keeps it in the sheet.
  function markHistory() {
    try { history.pushState({ [SHEET_MARK]: true }, ''); } catch { /* no history here: the X still works */ }
  }

  function helpShown(mount) {
    const box = mount.querySelector('.xfer-help');
    return !!box && !box.hidden;
  }

  // One Esc, one step: the help goes first, the sheet after it.
  function stepBack() {
    const mount = sheetHold.sheet.querySelector('.transfer-widget-mount');
    if (helpShown(mount)) toggleHelp(mount, false);
    else closeSheet();
  }

  // Back is the same step. It has already spent our history entry, so a sheet that
  // stays open takes a new one.
  function onBack() {
    if (!sheetHold.sheet) return;
    const mount = sheetHold.sheet.querySelector('.transfer-widget-mount');
    if (!helpShown(mount)) { closeSheet(true); return; }
    toggleHelp(mount, false);
    markHistory();
  }

  window.TransferWidgetSheetSteps = {
    sheetHold, toggleHelp, PULL_CLOSE_SHARE, PULL_FLICK, PULL_FLICK_MIN, PULL_FLICK_FRESH, closeSheet,
    markHistory, stepBack, onBack,
  };
})();
