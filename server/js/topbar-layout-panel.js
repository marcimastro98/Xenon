'use strict';

// The bar panel of Layout mode: "Customize bar" in the Layout dock opens a side
// sheet with the parts of Settings → Top bar a person reaches for while looking
// at the bar: the ready-made looks, the buttons (order, side, hidden, each
// one's icon, label and colours) and, in Minimal and None, the side rails. The
// controls are the Settings page's own (js/topbar-look-settings.js,
// renderTopbarActionsEditor in settings.js), so both places write the same keys
// and repaint together. Everything else stays one tap away under "All options".
// Listeners are added on open and removed on close; leaving Layout mode closes it.
(function () {
  let panel = null;
  let onKey = null;

  function text(tag, key, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.setAttribute('data-i18n', key);
    el.textContent = t(key);
    return el;
  }

  function section(titleKey, hintKey, body) {
    const box = document.createElement('section');
    box.className = 'tbp-sec';
    const head = document.createElement('div');
    head.className = 'tbp-sec-head';
    head.append(text('h3', titleKey, 'tbp-sec-title'));
    if (hintKey) head.append(text('p', hintKey, 'settings-hint'));
    box.append(head, body);
    return box;
  }

  function closeIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M18 6 6 18M6 6l12 12');
    svg.append(path);
    return svg;
  }

  // Rails exist in Minimal and None, never on a phone (one stacked column).
  function hasRails() {
    if (document.documentElement.classList.contains('is-stacked')) return false;
    const layout = typeof getDashboardLayout === 'function' ? getDashboardLayout() : null;
    return (layout && layout.topbarHidden === true) || hubSettings.topbarStyle === 'minimal';
  }

  function build() {
    const root = document.createElement('aside');
    root.className = 'tbp';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', t('settings_cat_island'));

    const head = document.createElement('div');
    head.className = 'tbp-head';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tbp-close';
    close.setAttribute('aria-label', t('tbp_close'));
    close.title = t('tbp_close');
    close.append(closeIcon());
    close.addEventListener('click', closePanel);
    head.append(text('h2', 'settings_cat_island', 'tbp-title'), close);

    const body = document.createElement('div');
    body.className = 'tbp-body';
    const presets = document.createElement('div');
    presets.className = 'tbl-presets tbp-presets';
    body.append(section('tbl_look_title', 'tbl_look_hint', presets));
    const buttons = document.createElement('div');
    buttons.id = 'tbp-actions-editor';
    buttons.className = 'island-edit-list tbp-list';
    body.append(section('topbar_btn_head', 'topbar_btn_hint', buttons));
    let rails = null;
    if (hasRails()) {
      rails = document.createElement('div');
      rails.className = 'tbl-custom-rows tbp-rows';
      body.append(section('tbl_rails_title', 'tbl_rails_hint', rails));
    }

    const foot = document.createElement('div');
    foot.className = 'tbp-foot';
    const all = text('button', 'tbp_all', 'settings-btn');
    all.type = 'button';
    all.addEventListener('click', () => {
      closePanel();
      if (typeof setDashboardLayoutEditMode === 'function') setDashboardLayoutEditMode(false);
      openSettings('island');
    });
    foot.append(all);

    root.append(head, body, foot);
    return { root, presets, rails };
  }

  function open() {
    if (panel) return;
    const built = build();
    panel = built.root;
    document.body.append(panel);
    window.TopbarLookSettings.mountInto(built.presets, 'presets');
    if (built.rails) window.TopbarLookSettings.mountInto(built.rails, 'rails');
    renderTopbarActionsEditor();
    onKey = (e) => { if (e.key === 'Escape') closePanel(); };
    document.addEventListener('keydown', onKey);
    panel.querySelector('.tbp-close').focus({ preventScroll: true });
  }

  function closePanel() {
    if (!panel) return;
    document.removeEventListener('keydown', onKey);
    onKey = null;
    panel.remove();
    panel = null;
  }

  window.TopbarLayoutPanel = { open, close: closePanel, isOpen: () => !!panel };
})();
