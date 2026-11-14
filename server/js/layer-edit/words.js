// The words the widget editor shows: its own, the name of a widget, what the tag on a frame says,
// and a row of the list to pick from.

(() => {
  'use strict';

  const names = new Map();   // widget id -> the name the server gives it

  const tr = (key, fallback) => {
    const text = typeof t === 'function' ? t(key) : '';
    return text && text !== key ? text : fallback;
  };

  const HINT = () => tr('layer_edit_hint', 'Drag a widget. Tap it for its choices.');

  function pickRow(label, onPick, thumb) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'layer-edit-pick';
    if (thumb) row.appendChild(thumb);
    const name = document.createElement('span');
    name.textContent = label;   // a Store widget's name is untrusted text
    row.appendChild(name);
    row.addEventListener('click', onPick);
    return row;
  }

  function nameOf(w) {
    const known = names.get(w.id) || w.pkg || w.widget || '';
    return w.kind === 'sdk' ? known : tr('layout_widget_' + w.widget, known);
  }

  // "In game", "With the music", "On Spotify": what the tag on a frame says.
  function tagOf(w) {
    const say = window.LayerSee.labelOf(w);
    if (say.text) return say.text;
    const words = tr(say.key, say.key);
    return Object.entries(say.vars || {}).reduce((text, [name, value]) => text.replace('{' + name + '}', value), words);
  }

  window.LayerEditWords = { names, tr, HINT, pickRow, nameOf, tagOf };
})();
