// The submit form's tag field. Each tag becomes a chip the moment it is complete
// (Enter, comma, space, the + button, or leaving the field), so nobody has to guess
// whether tags are split by commas or spaces. A tag is cleaned to what the hub keeps
// (lowercase letters, digits and dashes, at most 20 characters, at most 6 tags), and
// the hidden #tags input carries them space-separated, as /submit has always read them.
(function () {
  'use strict';

  var MAX_TAGS = 6;
  var MAX_LEN = 20;
  var SEPARATORS = /[\s,;]+/;

  var WORDS = {
    en: { placeholder: 'Type a tag and press Enter', more: 'Add another', add: 'Add tag', remove: 'Remove {tag}', full: 'That makes 6: remove one to add another.', count: '{n} of 6' },
    it: { placeholder: 'Scrivi un tag e premi Invio', more: 'Aggiungine un altro', add: 'Aggiungi tag', remove: 'Togli {tag}', full: 'Sono 6: togline uno per aggiungerne un altro.', count: '{n} di 6' },
    es: { placeholder: 'Escribe una etiqueta y pulsa Intro', more: 'Añade otra', add: 'Añadir etiqueta', remove: 'Quitar {tag}', full: 'Ya hay 6: quita una para añadir otra.', count: '{n} de 6' },
    fr: { placeholder: 'Tapez un tag puis Entrée', more: 'Ajoutez-en un autre', add: 'Ajouter le tag', remove: 'Retirer {tag}', full: 'Il y en a 6 : retirez-en un pour en ajouter un autre.', count: '{n} sur 6' },
    ja: { placeholder: 'タグを入力して Enter', more: 'さらに追加', add: 'タグを追加', remove: '{tag} を削除', full: '6 個になりました。追加するには 1 つ削除してください。', count: '{n} / 6' },
    ko: { placeholder: '태그를 입력하고 Enter', more: '하나 더 추가', add: '태그 추가', remove: '{tag} 삭제', full: '6개가 되었습니다. 추가하려면 하나를 삭제하세요.', count: '{n} / 6' },
    zh: { placeholder: '输入标签后按回车', more: '再加一个', add: '添加标签', remove: '移除 {tag}', full: '已有 6 个：先移除一个再添加。', count: '{n} / 6' }
  };

  var lang = 'en';
  var tags = [];
  var els = null;

  function w(key, tag) {
    var text = (WORDS[lang] || WORDS.en)[key] || WORDS.en[key];
    return text.replace('{tag}', tag || '').replace('{n}', String(tags.length));
  }

  // What the hub keeps of a typed word: "#Neon_Glow!" becomes "neon-glow".
  function clean(raw) {
    return String(raw || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/^#+/, '').replace(/[_.]+/g, '-').replace(/[^a-z0-9-]/g, '')
      .replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, MAX_LEN);
  }

  function add(raw) {
    var tag = clean(raw);
    if (!tag || tags.indexOf(tag) >= 0 || tags.length >= MAX_TAGS) return false;
    tags.push(tag);
    return true;
  }

  // Turns the typed text into chips. `all` also takes the last word; while typing,
  // a word becomes a chip only once a separator follows it.
  function commit(all) {
    if (!els) return;
    var before = tags.join(' ');
    var parts = els.input.value.split(SEPARATORS);
    var rest = all ? '' : parts.pop();
    parts.forEach(add);
    var left = tags.length >= MAX_TAGS ? '' : rest;
    if (els.input.value !== left) els.input.value = left;
    // Redraw only on a change: a blur that redrew the chips would swallow the
    // click on a chip's remove button that caused it.
    if (tags.join(' ') !== before) render();
  }

  function removeAt(i) {
    tags.splice(i, 1);
    render();
    els.input.focus();
  }

  function chip(tag, i) {
    var li = document.createElement('span');
    li.className = 'tag-chip';
    li.setAttribute('role', 'listitem');
    var word = document.createElement('span');
    word.textContent = tag;
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'tag-x';
    x.setAttribute('aria-label', w('remove', tag));
    x.textContent = '×';
    x.addEventListener('click', function () { removeAt(i); });
    li.append(word, x);
    return li;
  }

  // The + is live only while there is a word to add.
  function syncAdd() {
    els.addBtn.disabled = !els.input.value.trim();
  }

  function render() {
    var full = tags.length >= MAX_TAGS;
    els.list.replaceChildren.apply(els.list, tags.map(chip));
    els.hidden.value = tags.join(' ');
    // Six chips: the text stays focused but takes nothing more (the CSS folds it away),
    // so Backspace still takes the last chip and a stray key changes nothing.
    els.input.readOnly = full;
    els.input.placeholder = full ? '' : w(tags.length ? 'more' : 'placeholder');
    els.addBtn.hidden = full;
    els.addBtn.setAttribute('aria-label', w('add'));
    els.note.textContent = full ? w('full') : (tags.length ? w('count') : '');
    syncAdd();
  }

  function onKey(ev) {
    if (ev.key === 'Enter' || ev.key === ',') {
      ev.preventDefault(); // Enter must not send the whole form
      commit(true);
    } else if (ev.key === 'Backspace' && !els.input.value && tags.length) {
      ev.preventDefault();
      removeAt(tags.length - 1);
    }
  }

  window.XenonSubmitTags = {
    mount: function (opts) {
      els = {
        input: opts.input, hidden: opts.hidden, list: opts.list, addBtn: opts.addBtn, note: opts.note
      };
      lang = opts.lang || 'en';
      els.input.addEventListener('keydown', onKey);
      els.input.addEventListener('input', function () { commit(false); syncAdd(); });
      els.input.addEventListener('blur', function () { commit(true); });
      els.addBtn.addEventListener('click', function () { commit(true); els.input.focus(); });
      String(els.hidden.value || '').split(SEPARATORS).forEach(add);
      render();
    },
    setLang: function (l) { lang = l; if (els) render(); },
    // Takes a word still in the box, so pressing Send right after typing keeps it.
    commit: function () { commit(true); },
    // Replaces the chips with these words (the form refilled from a status link).
    set: function (raw) {
      tags = [];
      String(raw || '').split(SEPARATORS).forEach(add);
      if (els) render();
    },
    clean: clean
  };
})();
