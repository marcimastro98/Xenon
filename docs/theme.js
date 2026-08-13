/* ============================================================================
   theme.js — light / dark / system, on every page of xenon-app.com
   ============================================================================

   Three states, and the default is SYSTEM: with no choice stored nothing is
   written to <html> and /site.css lets `prefers-color-scheme` decide. Picking
   light or dark writes data-theme, which beats the media query both ways.

   The APPLY half must not live here. A deferred script runs after the first
   paint, so a visitor who chose dark on a light machine would see the other
   ground flash first. Every page carries the same four-line snippet inline in
   its <head>; this file only builds the control and keeps it in step.

   It carries its own strings AND its own CSS, for the same reason /consent.js
   does: the five dictionaries live one per page, the nav markup differs three
   ways across the site, and four pages have no language picker to borrow
   styling from. Depending on any of that would mean a control that renders
   unstyled — a menu with no `display:none` is a list of three words sitting in
   the middle of the header — on exactly the pages nobody checks. Class names
   are prefixed xt- so they cannot collide with a page's own.
   ========================================================================= */
(function () {
  'use strict';

  var KEY = 'xenon.site.theme';
  var MODES = ['system', 'light', 'dark'];

  var T = {
    en: { label: 'Theme', system: 'System', light: 'Light', dark: 'Dark' },
    it: { label: 'Tema',  system: 'Sistema', light: 'Chiaro', dark: 'Scuro' },
    ko: { label: '테마',   system: '시스템',  light: '라이트',  dark: '다크' },
    ja: { label: 'テーマ', system: 'システム', light: 'ライト', dark: 'ダーク' },
    zh: { label: '主题',   system: '跟随系统', light: '浅色',   dark: '深色' }
  };

  var CSS = [
    '.xt-theme{position:relative;display:inline-flex;align-items:center;font-family:var(--mono);}',
    '.xt-btn{display:inline-flex;align-items:center;gap:5px;background:none;border:0;padding:4px 2px;',
    '  font:inherit;font-size:12.5px;color:var(--bone-2);cursor:pointer;line-height:1.4;}',
    '.xt-btn:hover{color:var(--bone-0);}',
    '.xt-caret{font-size:9px;line-height:1;}',
    '.xt-menu{position:absolute;top:calc(100% + 10px);right:0;min-width:150px;z-index:80;display:none;',
    '  background:var(--g-0);border:1px solid var(--rule-2);border-radius:var(--r-1);padding:6px;}',
    '.xt-theme.xt-open .xt-menu{display:block;}',
    '.xt-menu button{display:block;width:100%;text-align:left;background:none;border:0;cursor:pointer;',
    '  font:inherit;font-size:12.5px;color:var(--bone-1);padding:7px 10px;border-radius:var(--r-1);}',
    '.xt-menu button:hover{background:var(--g-2);color:var(--bone-0);}',
    '.xt-menu button.xt-on{color:var(--bone-0);font-weight:600;}'
  ].join('\n');

  function lang() {
    var l;
    try { l = localStorage.getItem('xenon.site.lang'); } catch (e) { /* private mode */ }
    if (!l) l = (document.documentElement.lang || 'en').slice(0, 2);
    return T[l] ? l : 'en';
  }
  function t(k) { return (T[lang()] || T.en)[k]; }

  function stored() {
    var v;
    try { v = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    return MODES.indexOf(v) > -1 ? v : 'system';
  }

  function apply(mode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    try { localStorage.setItem(KEY, mode); } catch (e) { /* private mode */ }
    document.dispatchEvent(new CustomEvent('xenon:theme', { detail: mode }));
  }

  function style() {
    if (document.getElementById('xt-theme-style')) return;
    var st = document.createElement('style');
    st.id = 'xt-theme-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* Where the control goes, in order of preference. The site has three header
     shapes and four pages with no preferences area at all, so this walks from
     "beside the language picker" down to "the header" and finally the footer,
     rather than assuming one nav. */
  var HOSTS = [
    '[data-theme-switch]',
    '.nav-actions', '.head-right', '#langbar', '.topbar-actions',
    'header .wrap', 'nav .wrap', 'header', 'footer'
  ];

  function host() {
    for (var i = 0; i < HOSTS.length; i++) {
      var el = document.querySelector(HOSTS[i]);
      if (el) return el;
    }
    return document.body;
  }

  function mount() {
    style();

    var box = document.createElement('div');
    box.className = 'xt-theme';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xt-btn';
    btn.id = 'theme-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');

    var cur = document.createElement('span');
    cur.className = 'xt-cur';
    var caret = document.createElement('span');
    caret.className = 'xt-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    btn.appendChild(cur);
    btn.appendChild(caret);

    var menu = document.createElement('div');
    menu.className = 'xt-menu';
    menu.setAttribute('role', 'listbox');

    var buttons = {};
    MODES.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.dataset.theme = m;
      b.addEventListener('click', function () {
        apply(m);
        paint();
        close();
      });
      buttons[m] = b;
      menu.appendChild(b);
    });

    function close() { box.classList.remove('xt-open'); btn.setAttribute('aria-expanded', 'false'); }

    function paint() {
      var mode = stored();
      btn.setAttribute('aria-label', t('label'));
      cur.textContent = t(mode);
      MODES.forEach(function (m) {
        buttons[m].textContent = t(m);
        buttons[m].classList.toggle('xt-on', m === mode);
        buttons[m].setAttribute('aria-selected', String(m === mode));
      });
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = box.classList.toggle('xt-open');
      btn.setAttribute('aria-expanded', String(open));
      // Never two panels at once. Both siblings stop propagation on their own
      // buttons, which is also why the listener below is on the capture phase.
      // A panel this control has been moved INTO is skipped: closing it would
      // take the control away mid-click (the home bar parks it in More on a
      // phone).
      ['lang', 'navmore'].forEach(function (id) {
        var el = document.getElementById(id);
        if (open && el && !el.contains(box)) el.classList.remove('open');
      });
    });
    document.addEventListener('click', function (e) { if (!box.contains(e.target)) close(); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    document.addEventListener('xenon:lang', paint);

    box.appendChild(btn);
    box.appendChild(menu);
    host().appendChild(box);
    paint();

    // A page that wants the control somewhere else at some width can move the
    // node once it exists (the home bar parks it in its More menu on a phone).
    // Announcing it beats every page racing this file's own mount.
    document.dispatchEvent(new CustomEvent('xenon:theme-mounted', { detail: box }));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
