// The list a widget is picked from, as it is drawn: the search and the chips, the rows by pack, the
// way to get more, and the installed ones that did not load.
'use strict';

window.CustomWidgetPickList = (wrapper) => {
  const {
    el, fetched, missingExamples, openPermDialog, installExample, appendWeatherMakers,
  } = wrapper;

  const { hostKindOf } = window.CustomWidgetInstances;
  const { t } = window.CustomWidgetHostSays;
  const {
    PICK_CATS, PICK_FILTER_MIN, PICK_BROKEN_REASONS, PICK_BROKEN_MAX, pickFilter, pickNorm,
    pickCatsOf,
  } = window.CustomWidgetPickerWords;

  // Untrusted manifest text (name/author/description) → textContent only.
  function paintPicker(body, instId) {
    const frag = document.createDocumentFragment();
    // A Weather tile offers only the widgets that read the weather.
    const forWeather = hostKindOf(instId) === 'weather';
    frag.appendChild(el('div', 'cw-pick-title', forWeather
      ? t('cw_pick_weather', 'Choose your weather widget')
      : t('cw_pick', 'Choose a widget for this tile')));

    // One flat model for both installed packages and not-yet-installed bundled
    // examples, so search and chips treat them identically.
    // Ambient scenes render fullscreen, not in a tile — they're picked in
    // Settings → Ambient, so keep them out of the tile picker.
    const items = (fetched.pkgCache.packages || [])
      .filter(pkg => pkg && pkg.surface !== 'ambient')
      .filter(pkg => !forWeather || (Array.isArray(pkg.streams) && pkg.streams.includes('weather')))
      .map(pkg => ({
        kind: 'pkg',
        pkg,
        // Group by "pack" — the manifest author (e.g. "Xenon · Cyberpunk pack").
        group: (pkg.author && String(pkg.author).trim()) || '',
        name: pkg.name,
        desc: pkg.description || '',
        cats: pickCatsOf(pkg.streams),
      }))
      .concat((forWeather ? [] : missingExamples()).map(ex => ({
        kind: 'example',
        ex,
        group: t('cw_pick_examples', 'Xenon · Examples'),
        name: ex.name,
        desc: ex.desc || '',
        cats: ['other'],
      })));
    items.forEach(it => { it.hay = pickNorm(it.name + ' ' + it.group + ' ' + it.desc); });

    const state = pickFilter.get(instId) || { q: '', cat: '' };
    const cats = PICK_CATS.filter(c => items.some(it => it.cats.includes(c.id)));
    // "Other" only earns a chip when there is something else to tell it apart from.
    if (cats.length && items.some(it => it.cats.includes('other'))) {
      cats.push({ id: 'other', key: 'cw_cat_other', fb: 'Other' });
    }
    if (state.cat && !cats.some(c => c.id === state.cat)) state.cat = '';

    const list = el('div', 'cw-pick-list');

    // Only the rows repaint on every keystroke — the search field itself is
    // built once and stays focused while the user types.
    const renderRows = () => {
      const q = pickNorm(state.q).trim();
      const terms = q ? q.split(/\s+/) : [];
      const shown = items.filter(it => (
        (!state.cat || it.cats.includes(state.cat)) &&
        terms.every(term => it.hay.includes(term))
      ));
      const rows = document.createDocumentFragment();
      if (!shown.length) {
        rows.appendChild(el('div', 'cw-pick-empty', forWeather && !items.length
          ? t('cw_pick_weather_none', 'No widget of yours reads the weather yet. Make one with Bit or in Xenon Maker, or get one from the Store.')
          : t('cw_pick_none', 'No widget matches this search.')));
      }
      // Named packs first (alphabetical); widgets with no author fall through
      // last with no header. Group text is untrusted → el() sets textContent.
      const groups = new Map();
      shown.forEach(it => {
        if (!groups.has(it.group)) groups.set(it.group, []);
        groups.get(it.group).push(it);
      });
      const keys = Array.from(groups.keys()).sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
      keys.forEach(key => {
        if (key) rows.appendChild(el('div', 'cw-pick-group', key));
        groups.get(key).forEach(it => {
          const row = el('div', 'cw-pick-row');
          const txt = el('div', 'cw-pick-txt');
          txt.appendChild(el('div', 'cw-pick-name', it.name));
          if (it.kind === 'pkg') {
            // Author is the group header — the row meta keeps only the version.
            const meta = it.pkg.version ? 'v' + it.pkg.version : '';
            if (meta) txt.appendChild(el('div', 'cw-pick-meta', meta));
          }
          if (it.desc) txt.appendChild(el('div', 'cw-pick-desc', it.desc));
          row.appendChild(txt);
          const isPkg = it.kind === 'pkg';
          const add = el('button', 'cw-btn' + (isPkg ? ' cw-btn--primary' : ''),
            isPkg ? t('cw_add', 'Add') : t('cw_install', 'Install'));
          add.type = 'button';
          // One tap installs an example, then the list repaints with the
          // package's own row (and its Add button) in place of this one.
          add.addEventListener('click', () => (isPkg ? openPermDialog(it.pkg, instId) : installExample(it.ex.id)));
          row.appendChild(add);
          rows.appendChild(row);
        });
      });
      // Always offer a way to get more, even when packs are installed.
      const createRow = el('div', 'cw-pick-create');
      const storeBtn = el('button', 'cw-btn cw-btn--primary', '＋ ' + t('cw_get_more', 'Get more widgets'));
      storeBtn.type = 'button';
      storeBtn.addEventListener('click', () => { if (window.CommunityGallery) window.CommunityGallery.open('widget'); });
      createRow.appendChild(storeBtn);
      if (forWeather) appendWeatherMakers(createRow);
      rows.appendChild(createRow);
      list.replaceChildren(rows);
    };

    if (items.length >= PICK_FILTER_MIN) {
      pickFilter.set(instId, state);
      const bar = el('div', 'cw-pick-filter');
      const search = el('div', 'cw-pick-search');
      const input = document.createElement('input');
      input.type = 'search';
      input.className = 'cw-pick-input';
      input.value = state.q;
      input.placeholder = t('cw_pick_search', 'Search widgets…');
      input.setAttribute('aria-label', t('cw_pick_search', 'Search widgets…'));
      input.addEventListener('input', () => { state.q = input.value; renderRows(); });
      search.appendChild(input);
      bar.appendChild(search);
      if (cats.length > 1) {
        const chips = el('div', 'cw-pick-chips');
        const mk = (id, label) => {
          const chip = el('button', 'cw-pick-chip' + (state.cat === id ? ' is-on' : ''), label);
          chip.type = 'button';
          chip.setAttribute('aria-pressed', state.cat === id ? 'true' : 'false');
          chip.addEventListener('click', () => {
            state.cat = state.cat === id ? '' : id;   // tapping the active chip clears it
            chips.querySelectorAll('.cw-pick-chip').forEach(c => {
              const on = c.dataset.cat === state.cat;
              c.classList.toggle('is-on', on);
              c.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            renderRows();
          });
          chip.dataset.cat = id;
          chips.appendChild(chip);
        };
        mk('', t('cw_cat_all', 'All'));
        cats.forEach(c => mk(c.id, t(c.key, c.fb)));
        bar.appendChild(chips);
      }
      frag.appendChild(bar);
    } else {
      pickFilter.delete(instId);
      state.q = ''; state.cat = '';
    }

    renderRows();
    frag.appendChild(list);

    // Installed, on disk, and skipped by the rescan. Deliberately OUTSIDE
    // renderRows and never filtered by the search or the chips: the situation
    // this exists for is somebody typing the name of the widget that is not
    // there, and hiding the explanation behind the same filter that is hiding
    // the widget would leave the panel saying nothing again.
    // Ids and reasons come from folder names on disk — el() sets textContent.
    const broken = (fetched.pkgCache && Array.isArray(fetched.pkgCache.invalid) ? fetched.pkgCache.invalid : []).slice(0, PICK_BROKEN_MAX);
    // Packages the engine stopped short of loading. Not a broken folder — these
    // are installed and fine, and the list simply ends before them. It belongs in
    // the same box for the same reason: somebody is looking for a widget that is
    // not here, and the answer is on this screen or nowhere.
    const skipped = Math.max(0, Number(fetched.pkgCache && fetched.pkgCache.skipped) || 0);
    if (broken.length || skipped) {
      const box = el('div', 'cw-pick-broken');
      box.appendChild(el('div', 'cw-pick-broken-title', t('cw_pick_broken', 'Some installed widgets did not load')));
      if (skipped) {
        box.appendChild(el('div', 'cw-pick-broken-row',
          t('cw_pick_skipped', 'This dashboard loads a limited number of widgets, and #n more are installed beyond it. Remove some in Settings to make room.')
            .replace('#n', String(skipped))));
      }
      broken.forEach((b) => {
        const id = String((b && b.id) || '').slice(0, 60);
        const code = String((b && b.reason) || '');
        const known = PICK_BROKEN_REASONS[code];
        const said = known ? t(known.key, known.fb) : code;
        box.appendChild(el('div', 'cw-pick-broken-row', said ? id + ' — ' + said : id));
      });
      if (broken.length) {
        box.appendChild(el('div', 'cw-pick-broken-hint',
          t('cw_pick_broken_hint', 'Reinstall them from the Store, or remove them there.')));
      }
      frag.appendChild(box);
    }

    body.replaceChildren(frag);
  }

  return { paintPicker };
};
