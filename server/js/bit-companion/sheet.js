'use strict';
// The Bit's room at full screen, opened from the companion, the Bit tile or a message
// (bit-companion/companion.js, tile.js): the room itself is bit-companion/room.js. Esc closes its
// drawer first, then the room; other cards wait while it is open.
(() => {
  let ui = null; // { overlay, room, letGo }

  function close() {
    if (!ui) return;
    const { overlay, room, letGo } = ui;
    ui = null;
    letGo?.();
    room.destroy();
    overlay.remove();
    window.BitStroll?.settle(); // a place changed in the room is reached now, in view
  }

  function open() {
    const bit = window.BitApp?.state();
    if (bit?.ok !== true || !window.BitRoom) return false;
    if (ui) { ui.room.fill(bit); return true; }
    const overlay = makeEl('div', 'bitc-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.tabIndex = -1;
    document.body.append(overlay);
    const room = window.BitRoom.mount(overlay, { mode: 'sheet', close });
    overlay.setAttribute('aria-labelledby', room.titleId);
    ui = { overlay, room, letGo: null };
    const onEsc = () => { if (!room.escape()) close(); };
    if (window.DialogFocus) ui.letGo = window.DialogFocus.hold(overlay, { onEsc });
    else overlay.focus({ preventScroll: true });
    return true;
  }

  if (window.XenonInterrupts) window.XenonInterrupts.registerOverlay('.bitc-overlay');
  window.BitSheet = { open, close, isOpen: () => !!ui };
})();
