// The small parts the Deck's windows are drawn from: a word in the user's language, an element, and
// a full-width row with a switch.
'use strict';

(() => {
  const tr = (k, fb) => (typeof t === 'function' ? t(k) : (fb != null ? fb : k));

  const el = makeEl; // shared DOM factory from utils.js

  // A full-width labelled switch row, for the deck-wide on/off choices.
  function switchRow(labelKey, labelFb, on, onChange) {
    const row = el('button', 'deck-ed-switchrow'); row.type = 'button';
    row.setAttribute('role', 'switch');
    row.appendChild(el('span', 'deck-ed-switchtxt', tr(labelKey, labelFb)));
    row.appendChild(el('span', 'deck-ed-switch'));
    let state = !!on;
    const paint = () => row.setAttribute('aria-checked', state ? 'true' : 'false');
    row.addEventListener('click', () => { state = !state; paint(); onChange(state); });
    paint();
    return row;
  }

  window.DeckParts = { tr, el, switchRow };
})();
