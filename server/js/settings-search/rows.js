// What a row of Settings says about itself to the search: the key of its label, the name of the
// section it sits under, whether this machine shows it and whether it is on screen.
'use strict';

(() => {
  function keyOf(el) {
    return el ? (el.getAttribute('data-i18n') || '') : '';
  }

  function labelKeyOf(row) {
    const line = row.querySelector('.settings-label-line [data-i18n]:not(.settings-hint)');
    if (line) return keyOf(line);
    for (const el of row.querySelectorAll('[data-i18n]')) {
      if (el.classList.contains('settings-hint') || el.tagName === 'OPTION' || el.tagName === 'BUTTON') continue;
      return keyOf(el);
    }
    return row.hasAttribute('data-i18n') ? keyOf(row) : '';
  }

  // A row the user cannot see on this machine is not a result: a Windows-only
  // row on macOS, or a row hidden because it does not apply right now (the Pixel
  // Retro sub-toggle, the other AI providers' panels). Only what is hidden BELOW
  // the card counts, because the cards themselves are hidden by the category
  // switch. A block marked data-behind-switch stays findable: it goes away with
  // a switch of its own, and reveal() lands on that switch.
  function reachable(el, card) {
    const off = window.XenonPlatform && window.XenonPlatform !== 'win32';
    if (off && el.closest('[data-settings-win-only]')) return false;
    for (let n = el; n && n !== card; n = n.parentElement) {
      if (n.hasAttribute('data-behind-switch')) continue;
      if (n.hidden || n.style.display === 'none') return false;
    }
    return true;
  }

  // The name of a section, or of a row that opens.
  function placeKey(place) {
    const name = place.matches('details')
      ? place.querySelector(':scope > summary [data-i18n]:not(.settings-hint)')
      : place.querySelector(':scope > .settings-section-title[data-i18n], :scope > .settings-section-title > [data-i18n]');
    return keyOf(name);
  }

  function onScreen(el) {
    return el.getClientRects().length > 0;
  }

  window.SettingsSearchRows = { keyOf, labelKeyOf, reachable, placeKey, onScreen };
})();
