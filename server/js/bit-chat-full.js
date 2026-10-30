// On a phone the chat tile is too small to talk in, so a tap on it gives Bit the
// whole screen: the pane moves into a sheet on <body> and a placeholder keeps
// its place in the tile. It has to move, not just go position:fixed, because
// the tile is a size container (MediaPanel.css), which traps fixed children.
// The head's back arrow, Escape or the phone's own back button put it back.
// The move uses moveNode(), so the live session and its listeners stay put.
(function (root) {
  const PANE = '[data-chatf="pane"]';
  const NARROW = '(max-width: 600px)';
  const HISTORY_MARK = 'bitChatSheet';

  // Pure: should this tap open the sheet?
  function shouldOpen({ narrow, editing, inSheet }) {
    return !!narrow && !editing && !inSheet;
  }

  let sheet = null;
  let placeholder = null;
  let pane = null;

  const isOpen = () => !!pane;

  function focusInput(p) {
    const input = p.querySelector('.ai-text-input');
    if (input && !input.disabled) input.focus({ preventScroll: true });
  }

  function open(target) {
    if (isOpen()) return;
    sheet = document.createElement('div');
    sheet.className = 'bit-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', typeof t === 'function' ? t('bit_chat_label') : 'Bit');
    placeholder = document.createElement('span');
    placeholder.hidden = true;
    target.parentNode.insertBefore(placeholder, target);
    document.body.appendChild(sheet);
    moveNode(sheet, target);
    pane = target;
    document.body.classList.add('bit-sheet-open');
    try { history.pushState({ [HISTORY_MARK]: true }, ''); } catch { /* no history here: the arrow still works */ }
  }

  // fromHistory: the phone's back button already popped our entry.
  function close(fromHistory) {
    if (!isOpen()) return;
    if (placeholder && placeholder.isConnected) {
      moveNode(placeholder.parentNode, pane, placeholder);
      placeholder.remove();
    }
    sheet.remove();
    sheet = placeholder = pane = null;
    document.body.classList.remove('bit-sheet-open');
    if (!fromHistory && history.state && history.state[HISTORY_MARK]) history.back();
  }

  if (typeof document !== 'undefined') {
    const narrow = root.matchMedia ? root.matchMedia(NARROW) : null;

    document.addEventListener('click', (e) => {
      const target = e.target && e.target.closest ? e.target : null;
      if (!target) return;
      if (target.closest('[data-bit-back]')) { close(false); return; }
      const p = target.closest(PANE);
      if (!p) return;
      const ok = shouldOpen({
        narrow: narrow && narrow.matches,
        editing: document.body.classList.contains('layout-editing'),
        inSheet: !!p.closest('.bit-sheet'),
      });
      if (!ok) return;
      open(p);
      // The tap lands where the user meant it (a starter still sends); a tap on
      // the empty pane goes on to typing.
      if (!target.closest('button, a, input, textarea')) focusInput(p);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen() && !e.defaultPrevented) close(false);
    });

    root.addEventListener('popstate', () => { if (isOpen()) close(true); });

    // Turning the phone to a wide screen gives the tile its room back.
    if (narrow && narrow.addEventListener) narrow.addEventListener('change', () => { if (!narrow.matches) close(false); });
  }

  const api = { shouldOpen, close, isOpen };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BitChatFull = api;
})(typeof window !== 'undefined' ? window : globalThis);
