// The small pieces a device's controls are drawn from: a group with its label, a row of chips, and
// a switch with its words. Every text goes in as text.
'use strict';

(() => {
  const { prettify } = window.SmartHomeStateWords;

  const el = makeEl;   // shared DOM factory from utils.js

  function ctlGroup(labelText, node) {
    const g = el('div', 'sh-ctl');
    if (labelText) g.appendChild(el('div', 'sh-ctl-label', labelText));
    g.appendChild(node);
    return g;
  }

  // A wrapping row of selectable chips (sources, modes, presets, options…).
  function chipGroup(labelText, options, current, onPick, fmt) {
    const wrap = el('div', 'sh-chips');
    options.forEach((opt) => {
      const chip = el('button', 'sh-chip' + (String(opt) === String(current) ? ' is-active' : '')); chip.type = 'button';
      chip.textContent = fmt ? fmt(opt) : prettify(opt);
      chip.addEventListener('click', () => onPick(opt));
      wrap.appendChild(chip);
    });
    return ctlGroup(labelText, wrap);
  }

  function switchRow(labelText, on, onChange) {
    const row = el('div', 'sh-switchrow');
    row.appendChild(el('span', 'sh-ctl-label', labelText));
    const sw = el('button', 'sh-switch2' + (on ? ' is-on' : '')); sw.type = 'button';
    sw.addEventListener('click', () => { const next = !sw.classList.contains('is-on'); sw.classList.toggle('is-on', next); onChange(next); });
    row.appendChild(sw);
    return ctlGroup(null, row);
  }

  window.SmartHomePieces = { el, ctlGroup, chipGroup, switchRow };
})();
