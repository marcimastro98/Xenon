'use strict';

// What the last function did, on a line at the top of the Xenon menu's window
// (the page gives it the same card the screen would have shown: capture-toast.js,
// alert-toasts.js). The menu stays open, so it says it here instead of a second
// card over it. It stays until the next press: nothing to catch before it goes.
// Every text is set with textContent; a picture only from the card's `image`.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuResult = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function create(box, onAction) {
    const doc = box.ownerDocument;

    const el = (tag, cls, txt) => {
      const n = doc.createElement(tag);
      n.className = cls;
      if (txt) n.textContent = txt;
      return n;
    };

    function clear() {
      box.replaceChildren();
      box.hidden = true;
    }

    function picture(src) {
      const img = el('img', 'xm-result-img');
      img.alt = '';
      // No preview for this file: the words alone still say what happened.
      img.addEventListener('error', () => img.remove());
      img.src = src;
      return img;
    }

    function actionButton(a) {
      const b = el('button', a.primary ? 'xm-result-act is-primary' : 'xm-result-act', a.label);
      b.type = 'button';
      b.addEventListener('click', () => onAction(a));
      return b;
    }

    function show(card) {
      if (!card) { clear(); return; }
      const words = el('div', 'xm-result-words');
      const title = String(card.title || '');
      const kicker = String(card.kicker || '');
      if (kicker && !title.toLowerCase().startsWith(kicker.toLowerCase())) words.append(el('p', 'xm-result-kicker', kicker));
      words.append(el('p', 'xm-result-title', title));
      if (card.message) words.append(el('p', 'xm-result-message', String(card.message)));
      const parts = [words];
      if (typeof card.image === 'string' && card.image) parts.unshift(picture(card.image));
      const actions = Array.isArray(card.actions) ? card.actions : [];
      if (actions.length) {
        const row = el('div', 'xm-result-actions');
        row.append(...actions.map(actionButton));
        parts.push(row);
      }
      box.replaceChildren(...parts);
      box.dataset.type = String(card.type || 'info');
      box.hidden = false;
    }

    clear();
    return { show, clear };
  }

  return { create };
});
