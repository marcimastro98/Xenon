'use strict';

// Xenon's one place: the rail that Settings (index.html) and the Xenon menu's window
// (menu.html) both draw, from this one list. The first group is the menu's sections
// (server/menu/xenon-menu.js, drawn by js/menu/xenon-menu.js), the others are Settings' panes.
// Capture is both: on the dashboard the menu's capture rows sit over Settings'
// capture panes (js/menu/xenon-menu-panel.js), in the window "All options" opens them.
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonPages = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const SECTIONS = Object.freeze(['screens', 'now', 'airflow', 'capture', 'keys']);
  // [page, label key, icon of js/menu/xenon-menu-icons.js], group by group.
  const GROUPS = Object.freeze([
    { pages: [['screens', 'xmenu_sec_screens', 'screens'], ['now', 'xmenu_sec_now', 'bolt'], ['airflow', 'xmenu_sec_airflow', 'fan'],
      ['capture', 'xmenu_sec_capture', 'camera'], ['keys', 'xmenu_sec_keys', 'keyboard']] },
    { label: 'settings_title', pages: [['general', 'settings_cat_general', 'sliders'],
      ['appearance', 'settings_cat_appearance', 'paint'], ['island', 'settings_cat_island', 'island'],
      ['background', 'settings_cat_background', 'picture'], ['notifications', 'settings_cat_notifications', 'bell'], ['lock', 'settings_ambient', 'moon'],
      ['ai', 'settings_cat_bit', 'bit'], ['bit', 'settings_vitals', 'pulse']] },
    { label: 'settings_nav_widgets', pages: [['weather', 'settings_weather', 'cloud'],
      ['stocks', 'settings_cat_feeds', 'chart'], ['calendar', 'settings_calendar', 'calendar'],
      ['slideshow', 'settings_cat_slideshow', 'slides'], ['claude', 'settings_cat_coding', 'code']] },
    { label: 'settings_nav_integrations', pages: [['lighting', 'settings_cat_lighting', 'bulb'],
      ['smarthome', 'settings_ha_title', 'home'], ['unifi', 'settings_unifi_title', 'cctv'],
      ['spotify', 'settings_cat_spotify', 'spotify'], ['streaming', 'settings_cat_streaming', 'radio'],
      ['browser', 'settings_cat_browser', 'globe'], ['search', 'settings_cat_search', 'search'],
      ['secondscreen', 'settings_cat_secondscreen', 'cast'], ['phone', 'settings_cat_phone', 'phone'],
      ['remote', 'settings_cat_remote', 'remote']] },
    { label: 'settings_nav_system', pages: [['performance', 'settings_cat_performance', 'speed'],
      ['sdk', 'settings_cat_sdk', 'puzzle']] },
  ]);
  // Under the list on every height, after the Store and the Sparks that each host draws.
  const FOOT = Object.freeze([['support', 'settings_cat_support', 'heart'], ['about', 'settings_cat_about', 'info']]);
  const foot = () => FOOT.map(([page, label, icon]) => ({ page, label, icon }));
  // Names that links, Bit and older menus still use. The old Schermo page (display) is
  // Schermi now: the screen is chosen on the screens, the phone question is on Telefono.
  const ALIASES = Object.freeze({ codex: 'claude', ambient: 'lock', mode: 'screens', widgets: 'screens', look: 'screens', overlay: 'screens', display: 'screens' });
  const PAGES = Object.freeze([...GROUPS.flatMap((g) => g.pages), ...FOOT].map(([id]) => id));

  const pageOf = (id) => {
    const page = ALIASES[id] || id;
    return PAGES.includes(page) ? page : '';
  };
  const isSection = (id) => SECTIONS.includes(id);
  // A pane of Settings: what `settings:<cat>` may name (Capture has panes too).
  const isCat = (id) => PAGES.includes(id) && (!isSection(id) || id === 'capture');

  // The rows of the rail in order. `sections`: the menu's sections this place has;
  // `hidden`: pages it leaves out. A group left empty loses its heading.
  function rows(sections, hidden) {
    const out = [];
    for (const g of GROUPS) {
      const pages = g.pages.filter(([id]) => (isSection(id) ? sections.includes(id) : !hidden.includes(id)));
      if (!pages.length) continue;
      if (g.label) out.push({ head: g.label });
      out.push(...pages.map(([page, label, icon]) => ({ page, label, icon })));
    }
    return out;
  }

  // Rows as elements. `o`: { doc, t, icon(name), btn, head (classes), key (the
  // dataset name that carries the page, or a function of the page), pick(page) }. Labels keep their i18n key,
  // so a change of language reaches them where the page retranslates.
  function draw(list, o) {
    return list.map((r) => {
      const words = o.doc.createElement(r.head ? 'div' : 'span');
      words.dataset.i18n = r.head || r.label;
      words.textContent = o.t(r.head || r.label);
      if (r.head) {
        words.className = o.head;
        words.setAttribute('aria-hidden', 'true');
        return words;
      }
      const b = o.doc.createElement('button');
      b.type = 'button';
      b.className = o.btn;
      b.dataset[typeof o.key === 'function' ? o.key(r.page) : o.key] = r.page;
      const ic = o.icon(r.icon);
      if (ic) b.appendChild(ic);
      b.appendChild(words);
      b.addEventListener('click', () => o.pick(r.page));
      return b;
    });
  }

  // Settings' rail, drawn as soon as this script runs: the markup above it is parsed,
  // and Settings (js/settings/) reads the rail later (platform rows, the search, the sheet).
  // Its foot (the Store, the Sparks, FOOT) is the page's own markup.
  const page = typeof window !== 'undefined' ? /** @type {any} */ (window) : null;   // icons, Settings, words
  function fillSettings(doc, t) {
    const list = doc.getElementById('settings-nav-scroll');
    const icons = page?.XenonMenuIcons;
    if (!list || !icons) return;
    const pick = (p) => { if (typeof page.settingsSetCategory === 'function') page.settingsSetCategory(p); };
    const o = { doc, t, icon: (name) => icons.make(doc, name), btn: 'settings-nav-btn', head: 'settings-nav-label', key: 'settingsCat', pick };
    list.replaceChildren(...draw(rows(SECTIONS, []), o));
  }

  // A section only some PCs have leaves Settings' rail when the server says it is absent
  // (Fans: a Mac, a laptop). Until the answer comes, or without one, the row stays.
  const ONLY_WITH = Object.freeze({ airflow: 'fanControl' });
  async function hideAbsent(doc) {
    try {
      // Relative: both pages that draw the rail come from the server itself (SERVER is this origin).
      const res = await fetch('/actions/catalog', { cache: 'no-store' });
      const caps = res.ok ? (await res.json())?.capabilities : null;
      if (!caps) return;
      for (const [id, cap] of Object.entries(ONLY_WITH)) {
        if (caps[cap] !== false) continue;
        doc.querySelectorAll('.settings-nav-btn').forEach((b) => { if (b.dataset.settingsCat === id) b.hidden = true; });
      }
    } catch { /* the server is away: the rail stays as drawn */ }
  }

  if (typeof document !== 'undefined' && typeof page?.t === 'function') {
    fillSettings(document, page.t);
    hideAbsent(document);
  }

  return Object.freeze({ SECTIONS, PAGES, pageOf, isSection, isCat, rows, foot, draw });
});
