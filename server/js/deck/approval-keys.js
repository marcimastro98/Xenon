'use strict';
// Approval keys: the small pieces every "something is waiting for your OK" card
// on this dashboard needs, so a new card gets them right the first time.
//
//   ARMING      a card ignores taps for its first moments on screen, so a finger
//               already on its way somewhere else (or the tap that woke the
//               screen) cannot land on Allow as the card appears under it.
//   HOLD        an irreversible request is allowed by holding the key, not by
//               tapping it. A keyboard has no reliable hold, so there it is two
//               presses within three seconds.
//   PRESS GUARD a tap is pointerdown + pointerup on the SAME element; a tile
//               rebuilt by an SSE push between the two never receives its click.
//               While a pointer is down inside the scope, rebuilds wait and run
//               just after the click.
//   SCROLL      a rebuild keeps each scrolling area where the reader left it.
//   FOCUS       a rebuild gives the focus back to what carries `data-keep`.
//   SHEET       the window a request opens over the whole screen when it cannot
//               wait (components/AskSheet/): one for Codex and Claude Code.
//   QUESTION    the same window when the host itself asks: a widget's permissions,
//               a copy, a site, a pairing.
//
// The Claude Code tile grew arming, the press guard and the scroll first
// (js/claude-widget.js) and keeps its own copies of those; this file is the shared
// form for the Codex tile and whatever comes next. Pure DOM, no state of its own
// beyond what each caller creates, and the one first press below.
(function () {
  const PRESS_AGAIN_MS = 3000;
  // The first of the two presses a keyboard needs, by key: a push can rebuild the key
  // between them, and there is only one keyboard.
  let firstPress = { name: null, at: 0 };

  function createArming(armMs, onArmed) {
    const firstSeen = new Map();
    const timers = new Set();
    function isArmed(id) {
      if (!firstSeen.has(id)) firstSeen.set(id, Date.now());
      const left = firstSeen.get(id) + armMs - Date.now();
      if (left <= 0) return true;
      if (!timers.has(id)) {
        timers.add(id);
        setTimeout(() => { timers.delete(id); try { onArmed(); } catch { /* repaint */ } }, left + 30);
      }
      return false;
    }
    // Ids are unique per request; without this the map grows for as long as the
    // page is open.
    function forget(aliveIds) {
      const alive = new Set(aliveIds);
      for (const id of firstSeen.keys()) if (!alive.has(id)) firstSeen.delete(id);
    }
    return { isArmed, forget };
  }

  // `isArmed()` is asked at press time; `onConfirm()` runs after the hold.
  // `keep` names the key across rebuilds (see keepFocus).
  function holdButton({ className, label, pressAgain, holdMs, disabled, isArmed, onConfirm, keep }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    if (keep) b.dataset.keep = keep;
    const name = keep || b;
    const pressedOnce = () => firstPress.name === name && Date.now() - firstPress.at < PRESS_AGAIN_MS;
    const fill = document.createElement('span');
    fill.className = 'ak-fill';
    b.appendChild(fill);
    const text = document.createElement('span');
    text.className = 'ak-label';
    text.textContent = pressedOnce() ? pressAgain : label;
    b.appendChild(text);
    b.style.setProperty('--ak-hold', holdMs + 'ms');
    b.disabled = !!disabled;
    let timer = 0;
    const stop = () => { clearTimeout(timer); timer = 0; b.classList.remove('is-holding'); };
    b.addEventListener('pointerdown', (e) => {
      if (b.disabled || !isArmed()) return;
      try { b.setPointerCapture(e.pointerId); } catch { /* not every pointer captures */ }
      b.classList.add('is-holding');
      timer = setTimeout(() => { timer = 0; b.classList.remove('is-holding'); onConfirm(); }, holdMs);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (b.disabled || !isArmed()) return;
      if (pressedOnce()) { firstPress = { name: null, at: 0 }; onConfirm(); return; }
      firstPress = { name, at: Date.now() };
      text.textContent = pressAgain;
    });
    return b;
  }

  // `scope` is a selector; `render()` is what runs once the press is over, and
  // only if a rebuild was asked for meanwhile (`defer()`).
  function createPressGuard(scope, render) {
    let pressing = false;
    let deferred = false;
    let timer = 0;
    function release() {
      if (!pressing) return;
      pressing = false;
      clearTimeout(timer);
      if (!deferred) return;
      deferred = false;
      // After the click: it is dispatched after pointerup in the same task.
      setTimeout(render, 40);
    }
    document.addEventListener('pointerdown', (e) => {
      const target = e.target;
      if (!(target && target.closest && target.closest(scope))) return;
      pressing = true;
      clearTimeout(timer);
      // A release we never hear about must not hold rendering back for long.
      timer = setTimeout(release, 2500);
    }, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    return {
      get pressing() { return pressing; },
      defer() { deferred = true; },
    };
  }

  function keepScroll(root, selectors) {
    return selectors.map((sel) => Array.from(root.querySelectorAll(sel), (n) => n.scrollTop));
  }
  function restoreScroll(root, selectors, kept) {
    selectors.forEach((sel, i) => {
      root.querySelectorAll(sel).forEach((n, j) => { if (kept[i] && kept[i][j]) n.scrollTop = kept[i][j]; });
    });
  }

  // A text box inside a rebuilt subtree is a NEW element, so typing into one while a
  // session works lost focus on the next push, several times a second. What carries
  // `data-keep` gets focus and caret back after the rebuild; a box's text survives
  // because it is held in state, not in the DOM.
  function keepFocus(root) {
    const a = document.activeElement;
    const k = a && root.contains(a) && a.dataset ? a.dataset.keep : '';
    if (!k) return () => {};
    let s = null, e = null;
    try { s = a.selectionStart; e = a.selectionEnd; } catch { /* a number input has no selection */ }
    return () => {
      const n = Array.from(root.querySelectorAll('[data-keep]')).find((x) => x.dataset.keep === k);
      if (!n || n.disabled) return;
      try { n.focus({ preventScroll: true }); } catch { return; }
      if (s !== null) { try { n.setSelectionRange(s, e); } catch { /* not a text field */ } }
    };
  }

  function part(tag, className, text) {
    const n = document.createElement(tag);
    n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // One window for as long as something waits: every push repaints it, so the keyboard
  // and the freeze are taken once. The focus goes to the window, never to a key: a
  // stray Enter must not allow anything, and this can open with nobody looking.
  // `className` keeps the agent's tokens; `freeze` joins the registry every full-screen
  // backdrop is in, because the animations under it would go on costing frames.
  function createSheet({ className, freeze, scrollers: own = [], outside = false }) {
    // In a small window the sheet itself scrolls, and a push must not throw the reader back.
    const scrollers = ['.ask-sheet', ...own];
    let root = null;
    let letGo = null;
    let answer = null;
    const frozen = (on) => { if (typeof window.ambientFreeze === 'function') window.ambientFreeze(freeze, on); };
    function open() {
      root = part('div', 'ask-overlay ' + className);
      root.tabIndex = -1;
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      if (outside) root.addEventListener('click', (e) => { if (e.target === root) answer(); });
      document.body.appendChild(root);
      frozen(true);
      letGo = window.DialogFocus.hold(root, { onEsc: () => answer() });
    }
    // `esc` is the answer that starts nothing, for the request on screen now.
    function paint(card, { label, esc }) {
      if (!root) open();
      answer = esc;
      root.setAttribute('aria-label', label);
      const focus = keepFocus(root);
      const kept = keepScroll(root, scrollers);
      root.replaceChildren(card);
      restoreScroll(root, scrollers, kept);
      focus();
      const active = document.activeElement;
      if (!active || active === document.body) root.focus({ focusVisible: false });
    }
    function close() {
      if (!root) return;
      letGo();
      root.remove();
      root = null;
      frozen(false);
    }
    return { paint, close };
  }

  // Who is asking and what for. `mark` is the agent's own, `who` the name this is about.
  function sheetHead({ mark, title, who, line }) {
    const head = part('div', 'ask-head');
    if (mark) {
      const slot = part('span', 'ask-mark');
      slot.appendChild(mark);
      head.appendChild(slot);
    }
    const words = part('div', 'ask-words');
    words.appendChild(part('div', 'ask-title', title));
    const said = part('div', 'ask-line');
    if (who) said.appendChild(part('span', 'ask-who', who));
    if (line) said.append(line);
    words.appendChild(said);
    head.appendChild(words);
    return head;
  }

  // What happens if nobody answers, in words, and the keys. A plan has its keys in the
  // body, so `keys` can be left out.
  function sheetFoot({ timer, after, more, keys }) {
    const foot = part('div', 'ask-foot');
    const note = part('div', 'ask-note');
    note.append(timer, part('span', 'ask-after', after));
    if (more) note.appendChild(part('span', 'ask-more', more));
    foot.appendChild(note);
    if (keys) foot.appendChild(keys);
    return foot;
  }

  // Bit speaks for the host where its engine runs. A widget's own window has no engine:
  // there the `fallback`, the widget's icon, says who this is about.
  function hostMark(fallback) {
    const bit = part('span', 'ask-bit');
    if (window.BitApp) window.BitApp.showIcon(bit, 'idle');
    return bit.firstChild ? bit : (fallback || null);
  }

  function questionKey(text, press, className) {
    const key = part('button', className, text);
    key.type = 'button';
    key.addEventListener('click', press);
    return key;
  }

  // A question the host itself puts. Esc, a press outside the card and `no` are one
  // answer, so nothing reaches a yes by accident. The head and the keys stay on screen
  // and `body` scrolls between them; `note` is what the yes does besides, beside the
  // keys. Hands back `close` and the `main` key, which a question can keep off.
  function question({ className, freeze, small, mark, title, who, line, body, note, no, yes }) {
    const sheet = createSheet({ className, freeze, outside: true });
    const card = part('section', 'ask-sheet is-question' + (small ? ' is-small' : ''));
    const middle = part('div', 'ask-body');
    body.forEach((node) => middle.appendChild(node));
    const foot = part('div', 'ask-foot');
    if (note) foot.appendChild(part('div', 'ask-note', note));
    const keys = part('div', 'ask-keys');
    const main = questionKey(yes.label, yes.press, 'ask-key is-main');
    keys.append(questionKey(no.label, no.press, 'ask-key'), main);
    foot.appendChild(keys);
    card.append(sheetHead({ mark, title, who, line }), middle, foot);
    sheet.paint(card, { label: title, esc: no.press });
    return { close: sheet.close, main };
  }

  window.ApprovalKeys = {
    createArming, holdButton, createPressGuard, keepScroll, restoreScroll, keepFocus, createSheet, sheetHead, sheetFoot,
    hostMark, question,
  };
})();
