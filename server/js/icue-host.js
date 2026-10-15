'use strict';
// The Xenon iCUE widget is a frame around this page. Two things a browser does
// for free break inside it, and both need the widget page to act for us:
//
//  - Typing. iCUE gives a widget the keyboard only when its own focus listener
//    sees a text field focused in the widget's page; a field focused in here
//    reaches that page as the frame element, so the keyboard never arrives.
//    Framed, the dashboard tells the parent each time a text field takes
//    focus, and the widget asks iCUE for the keyboard with the call iCUE's own
//    listener makes. The message says that a field was focused, never what is
//    typed.
//  - Links. A link opened from a widget navigates the widget's own view, so
//    "open in browser" would replace the whole dashboard with a web page and
//    no way back. Once the parent has said it is the Xenon widget, window.open
//    and links that leave the dashboard are handed to it instead; it opens
//    them in the system browser through iCUE's link plugin.
//
// The target is '*' because the widget page has a file:// origin, which a
// postMessage target cannot name. Every other framing of the dashboard (a
// preview, a share card) never answers the hello, so links stay as they are.
//
// Pure parts exported for node tests (test/icue-host.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  api.install(root);
})(typeof self !== 'undefined' ? self : this, function () {
  const HELLO = 'xenon:hello';
  const KEYBOARD = 'xenon:keyboard';
  const WIDGET = 'xenon:widget';
  const OPEN = 'xenon:open';
  const READY = 'xenon:ready';

  // The same rule iCUE applies (WebEngineFocusController): these inputs take no
  // typing, so focusing one must not pull the keyboard away from a game.
  const NO_KEYBOARD_TYPES = new Set([
    'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
  ]);

  function needsKeyboard(el) {
    if (!el || typeof el.tagName !== 'string') return false;
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
    if (el.tagName !== 'INPUT') return false;
    return !NO_KEYBOARD_TYPES.has(String(el.type || '').toLowerCase());
  }

  function isFramed(win) {
    try { return win.top !== win.self; } catch { return true; }
  }

  // Only web links leave the dashboard; anything else (javascript:, data:,
  // custom schemes) is dropped rather than handed to the system.
  function webUrl(raw, base) {
    try {
      const url = new URL(String(raw), base);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch { return null; }
  }

  function forwardLinks(win, tell) {
    const open = (raw) => {
      const url = webUrl(raw, win.location.href);
      if (url) tell({ type: OPEN, url });
    };
    win.open = (raw) => { open(raw); return null; };
    win.document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || e.defaultPrevented) return;
      const url = webUrl(a.getAttribute('href'), win.location.href);
      if (!url) return;
      const leaves = a.target === '_blank' || new URL(url).origin !== win.location.origin;
      if (!leaves) return;
      e.preventDefault();
      open(url);
    });
  }

  function install(win) {
    if (!win || !isFramed(win)) return;
    const tell = (msg) => {
      try { win.parent.postMessage(msg, '*'); } catch { /* parent gone */ }
    };
    let linksForwarded = false;
    win.addEventListener('message', (e) => {
      if (e.source !== win.parent || !e.data || e.data.type !== WIDGET) return;
      // The answer tells the widget this page is alive; a frame stuck on a
      // browser error page cannot give it, so the widget reloads the frame.
      tell({ type: READY });
      if (linksForwarded) return;
      linksForwarded = true;
      forwardLinks(win, tell);
    });
    // Also lets the widget drop its fallback for dashboards older than this file.
    tell({ type: HELLO });
    win.document.addEventListener('focusin', (e) => {
      const target = e.composedPath ? e.composedPath()[0] : e.target;
      if (needsKeyboard(target)) tell({ type: KEYBOARD });
    }, true);
  }

  return { HELLO, KEYBOARD, WIDGET, OPEN, READY, needsKeyboard, isFramed, webUrl, install };
});
