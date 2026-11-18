// The index the search of Settings reads from the page: every row, button and section of
// #settings-content with its name in all languages and the place it sits under.
'use strict';

(() => {
  const { keyOf, labelKeyOf, reachable, placeKey } = window.SettingsSearchRows;

  const ROW_SEL = '.settings-toggle-row, .settings-row, .settings-vitals-row, .settings-ambient-row, .settings-supporter-row';
  const PLACE_SEL = 'details, .settings-section';
  const LABEL_MAX = 90;
  const VALUE_SEL = 'option[data-i18n], .settings-seg-btn[data-i18n], .settings-seg [data-i18n], button[data-i18n]';

  const content = (doc = document) => doc.getElementById('settings-content');

  // Every language for one key; see FuzzyFind.i18nFields for the weights.
  function fieldsFor(key, weight, opts) {
    if (typeof i18n !== 'object' || !i18n || !window.FuzzyFind) return [];
    const cur = (typeof lang === 'string' && lang) ? lang : 'en';
    return window.FuzzyFind.i18nFields(i18n, key, weight, { ...(opts || {}), lang: cur });
  }

  // What a row sits under, nearest first: the row that opens, the section, the
  // head of its card.
  function placeOf(row, card, headKey) {
    for (let n = row.parentElement; n && n !== card; n = n.parentElement) {
      const key = n.matches(PLACE_SEL) ? placeKey(n) : '';
      if (key) return key;
    }
    return headKey;
  }

  // `doc`: the page, or the dashboard's markup read by the Xenon window
  // (js/menu/xenon-menu-settings-find.js), whose rail is not drawn: `cats` names its pages.
  function build(doc = document, cats = null) {
    const list = [];
    const catKeys = cats ? { ...cats } : {};
    if (!cats) doc.querySelectorAll('#settings-nav [data-settings-cat]').forEach((b) => {
      if (b.hidden) return;
      const cat = b.dataset.settingsCat;
      // The Supporta footer button names the category in its title; its label
      // is the short form.
      const key = b.getAttribute('data-i18n-title') || keyOf(b.querySelector('[data-i18n]'));
      if (cat && key && !catKeys[cat]) catKeys[cat] = key;
    });

    for (const [cat, key] of Object.entries(catKeys)) {
      list.push({
        id: 'cat:' + cat, kind: 'cat', cat, labelKey: key,
        fields: [...fieldsFor(key, 1, { fuzzy: true }), ...fieldsFor('settings_kw_' + cat, 0.8, { fuzzy: true })],
      });
    }

    const root = content(doc);
    if (!root) return list;
    const seen = new Set();
    for (const card of root.children) {
      const cat = card.dataset && card.dataset.settingsCat;
      // No reachable() test on the card itself: every card outside the open category carries
      // `hidden` from settingsSetCategory, so that test indexed only the open
      // one. A card this machine lacks is caught by its category being absent
      // from the sidebar, or by the Windows-only mark.
      if (!cat || !catKeys[cat] || card.dataset.unavailable === '1') continue;
      if (window.XenonPlatform && window.XenonPlatform !== 'win32' && card.closest('[data-settings-win-only]')) continue;
      const catFields = fieldsFor(catKeys[cat], 0.3, { mainOnly: true });
      const headEl = card.querySelector('.settings-group-head [data-i18n]:not(.settings-hint)');
      const headKey = keyOf(headEl);
      const headHint = keyOf(card.querySelector('.settings-group-head .settings-hint[data-i18n]'));
      if (headKey) {
        list.push({
          id: cat + '|' + headKey, kind: 'card', cat, labelKey: headKey, hintKey: headHint, el: card,
          fields: [...fieldsFor(headKey, 1, { fuzzy: true }), ...fieldsFor(headHint, 0.4), ...catFields],
        });
      }
      const rows = card.querySelectorAll(ROW_SEL);
      const inRow = new Set();
      rows.forEach((row) => {
        if (!reachable(row, card)) return;
        const labelKey = labelKeyOf(row);
        if (!labelKey || labelKey === headKey) return;
        // A row nested in another row with the same label (a toggle-row used as
        // the caption of a vitals-row) is one setting, not two results.
        const outer = row.parentElement && row.parentElement.closest(ROW_SEL);
        if (outer && card.contains(outer) && labelKeyOf(outer) === labelKey) return;
        // A paragraph that happens to be the first text in a row is a note,
        // not the name of a setting.
        if (text(labelKey).length > LABEL_MAX) return;
        let id = cat + '|' + labelKey;
        for (let n = 2; seen.has(id); n++) id = cat + '|' + labelKey + '#' + n;
        seen.add(id);
        inRow.add(row);
        const cardKey = placeOf(row, card, headKey);
        const cardFields = fieldsFor(cardKey, 0.6, { mainOnly: true });
        const hintKey = keyOf(row.querySelector('.settings-hint[data-i18n]'));
        const values = [];
        row.querySelectorAll(VALUE_SEL).forEach((v) => { values.push(...fieldsFor(keyOf(v), 0.5)); });
        // Extra words for a row whose control has no translated text of its own
        // (°C / °F): data-search-kw names an i18n key, like settings_kw_<cat>.
        const kw = row.getAttribute('data-search-kw') || row.querySelector('[data-search-kw]')?.getAttribute('data-search-kw');
        if (kw) values.push(...fieldsFor(kw, 0.8, { fuzzy: true }));
        list.push({
          id, kind: 'row', cat, labelKey, hintKey, cardKey, el: row,
          fields: [...fieldsFor(labelKey, 1, { fuzzy: true }), ...fieldsFor(hintKey, 0.4), ...values, ...cardFields, ...catFields],
        });
      });
      // Actions that are not part of a named row: "Import theme…", "Export backup".
      card.querySelectorAll('.settings-btn[data-i18n]').forEach((btn) => {
        if ([...inRow].some((r) => r.contains(btn)) || !reachable(btn, card)) return;
        const labelKey = keyOf(btn);
        const id = cat + '|' + labelKey;
        if (seen.has(id)) return;
        seen.add(id);
        const cardKey = placeOf(btn, card, headKey);
        list.push({
          id, kind: 'action', cat, labelKey, cardKey, el: btn,
          fields: [...fieldsFor(labelKey, 0.9, { fuzzy: true }), ...fieldsFor(cardKey, 0.6, { mainOnly: true }), ...catFields],
        });
      });
      // A section, or a row that opens, is found by its own name too.
      card.querySelectorAll(PLACE_SEL).forEach((place) => {
        const labelKey = placeKey(place);
        const id = cat + '|' + labelKey;
        if (!labelKey || seen.has(id) || labelKey === headKey || !reachable(place, card)) return;
        seen.add(id);
        const hintKey = keyOf(place.querySelector(':scope > summary .settings-hint[data-i18n]'));
        list.push({
          id, kind: 'card', cat, labelKey, hintKey, el: place,
          fields: [...fieldsFor(labelKey, 1, { fuzzy: true }), ...fieldsFor(hintKey, 0.4), ...catFields],
        });
      });
    }
    for (const e of list) e.catKey = catKeys[e.cat];
    return list;
  }

  function text(key) {
    return key && typeof t === 'function' ? t(key) : '';
  }

  window.SettingsSearchIndexOfRows = { ROW_SEL, content, build, text };
})();
