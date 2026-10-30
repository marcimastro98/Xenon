'use strict';

// The "Main screen" tile (plan §20): what the Xenon menu does on the main
// screen, at a glance from the dashboard. The same rows as the menu (GET
// /xenon-menu): the quick actions, the widgets on the screen, the state, and
// "The whole menu" for everything else (js/xenon-menu-panel.js). Nothing here
// exists only on this tile: every button is a menu row.

(function () {
  if (!window.XenonMenuView) return;
  const V = window.XenonMenuView;
  const MAX_QUICK = 4;
  const MAX_WIDGETS = 4;
  const REFRESH_DELAY_MS = 300;
  const ERROR_FOR_MS = 6000;

  const section = document.querySelector('[data-dashboard-widget="screen"]');
  const mount = section && section.querySelector('.screen-tile-mount');
  if (!mount) return;
  let data = null;
  let timer = 0;
  let errorTimer = 0;
  let loading = false;
  let tried = false;      // "offline" only after a read has actually failed
  let errorText = '';     // kept so the redraw right after a failed act still shows it

  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  const button = (cls, txt) => {
    const b = el('button', cls, txt);
    b.type = 'button';
    return b;
  };
  const text = (x) => V.text(x, t);
  const rowsOf = (id) => ((data && data.sections || []).find((s) => s.id === id) || { rows: [] }).rows;

  function showError(code) {
    const D = window.DeckErrorText;
    errorText = V.fill(t('xmenu_failed'), { why: D ? D.describe(code, t) : String(code || '') });
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorText = '';
      paintError(mount.querySelector('.scr-error'));
    }, ERROR_FOR_MS);
    paintError(mount.querySelector('.scr-error'));
  }

  function paintError(box) {
    if (!box) return;
    box.textContent = errorText;
    box.hidden = !errorText;
  }

  async function act(a) {
    if (!a) return;
    if (a.open) { window.XenonMenuPanel.openVerb(a.open); return; }
    try {
      const res = await fetch(SERVER + '/actions/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a.run),
      });
      const r = await res.json().catch(() => null);
      if (!r || r.ok === false) showError((r && r.error) || 'unavailable');
    } catch (e) {
      showError('unavailable');
    }
    changed();
  }

  function group(titleKey, extra) {
    const g = el('div', 'scr-group');
    const head = el('div', 'scr-group-head');
    head.appendChild(el('span', 'scr-group-title', t(titleKey)));
    if (extra) head.appendChild(el('span', 'scr-group-sub', extra));
    g.appendChild(head);
    return g;
  }

  function quickGroup() {
    const tiles = rowsOf('now').filter((r) => r.kind === 'tile').slice(0, MAX_QUICK);
    if (!tiles.length) return null;
    const g = group('xmenu_sec_now');
    const grid = el('div', 'scr-quick');
    for (const r of tiles) {
      const b = button('scr-quick-btn');
      const ic = window.XenonMenuIcons && XenonMenuIcons.make(document, r.icon);
      if (ic) b.appendChild(ic);
      b.appendChild(el('span', 'scr-quick-label', text(r.label)));
      b.addEventListener('click', () => act(r.act));
      grid.appendChild(b);
    }
    g.appendChild(grid);
    return g;
  }

  function widgetsGroup() {
    const rows = rowsOf('widgets');
    const placed = rows.filter((r) => r.kind === 'widget');
    const pages = rows.find((r) => r.kind === 'pages');
    const page = pages && (pages.options || []).find((o) => String(o.value) === String(pages.value));
    const g = group('xmenu_sec_widgets', [page ? text(page.label) : '', placed.length ? V.fill(t('xmenu_widgets_count'), { n: placed.length }) : ''].filter(Boolean).join(', '));
    const list = el('div', 'scr-list');
    for (const r of placed.slice(0, MAX_WIDGETS)) {
      const li = el('div', 'scr-row');
      li.append(el('span', 'scr-name', text(r.label)), el('span', 'scr-value', text(r.value)));
      list.appendChild(li);
    }
    if (!placed.length) list.appendChild(el('p', 'scr-empty', t('xmenu_widgets_empty')));
    g.appendChild(list);
    const actions = el('div', 'scr-actions');
    const add = button('ui-btn ui-btn--secondary', t('xmenu_add'));
    add.addEventListener('click', () => window.XenonMenuPanel.open('widgets'));
    actions.appendChild(add);
    const edit = rows.find((r) => r.id === 'edit');
    if (edit) {
      const b = button('ui-btn ui-btn--secondary', text(edit.label));
      b.addEventListener('click', () => act(edit.act));
      actions.appendChild(b);
    }
    g.appendChild(actions);
    return g;
  }

  function stateGroup() {
    const rows = rowsOf('now').filter((r) => r.kind === 'status' && r.id !== 'last');
    if (!rows.length) return null;
    const g = group('xmenu_state');
    const list = el('div', 'scr-list');
    for (const r of rows) {
      const li = el('div', 'scr-row scr-tone-' + (r.tone || 'none'));
      li.append(el('span', 'scr-name', text(r.label)), el('span', 'scr-value', text(r.value)));
      list.appendChild(li);
    }
    g.appendChild(list);
    return g;
  }

  function draw() {
    const head = el('div', 'scr-head');
    head.appendChild(el('span', 'scr-title', t('layout_widget_screen')));
    const err = el('p', 'scr-error');
    err.setAttribute('role', 'status');
    paintError(err);
    const body = el('div', 'scr-body');
    if (!data) {
      body.appendChild(el('p', 'scr-empty', t(loading || !tried ? 'xmenu_loading' : 'xmenu_offline')));
    } else {
      [quickGroup(), widgetsGroup(), stateGroup()].filter(Boolean).forEach((g) => body.appendChild(g));
    }
    const all = button('ui-btn ui-btn--primary scr-all', t('xmenu_whole'));
    all.addEventListener('click', () => window.XenonMenuPanel.open('now'));
    mount.replaceChildren(head, err, body, all);
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch(SERVER + '/xenon-menu', { cache: 'no-store' });
      const next = res.ok ? await res.json() : null;
      if (next) data = next;
    } catch (e) { /* offline: the last rows stay, or the offline line */ }
    loading = false;
    tried = true;
    draw();
  }

  // Something the rows show changed (main.js relays the SSE events as
  // `xenon-menu-changed`): read again, once, while the tile is on the page.
  function changed() {
    if (!onPage) return;
    clearTimeout(timer);
    timer = setTimeout(load, REFRESH_DELAY_MS);
  }

  // Read only while the tile is on the page: a hidden tile costs nothing.
  let onPage = false;
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      const was = onPage;
      onPage = entries.some((e) => e.isIntersecting);
      if (onPage && !was) load();
    }).observe(section);
  } else {
    onPage = true;
    load();
  }

  window.addEventListener('xenon-menu-changed', changed);
  draw();
  // renderWidgets: applyTranslations() redraws the tile in the new language.
  window.ScreenTile = { refresh: load, renderWidgets: draw };
})();
