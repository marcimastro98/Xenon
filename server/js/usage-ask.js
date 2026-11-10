'use strict';

// "How do you want to use Xenon?": the one question of a new install, in the app that can
// draw widgets on the screen. It shows the person's real screens and what each will hold
// (js/usage-ask-picture.js, rules in js/usage-ask-plan.js), and the same answer says where
// the dashboard goes, so "Where do you want Xenon?" (js/surface-picker.js) is left to the
// browser and to shells without widgets.
//
// The person always chooses; the recommended row starts selected. Someone updating is not
// asked: they get 'both', which moves nothing on any screen. The Xenon menu, Settings and
// Bit change it later.
(function () {
  const TITLE = {
    both: 'usage_ask_both_title', widgets: 'usage_ask_widgets_title', dashboard: 'usage_ask_dash_title', phone: 'usage_ask_phone_title',
  };
  const RAILS_PEEK_MS = 3200;

  let overlay = null;
  let picture = null;
  let bit = null;
  let list = [];
  let advised = '';
  let picked = '';
  let dash = '';
  let touched = false;   // a row was chosen: a late list of screens must not change it
  let tapped = false;    // a screen was tapped: a late list must not move the dashboard
  let leaving = false;

  const plan = () => window.UsageAskPlan;

  function tr(key, fallback) {
    if (typeof t !== 'function') return fallback;
    const v = t(key);
    return (v && v !== key) ? v : fallback;
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  const settings = () => (typeof hubSettings === 'object' && hubSettings) || {};
  const current = () => (window.UsageMode ? window.UsageMode.normalize(settings().usageMode) : '');

  function menuKeyText() {
    const layers = settings().layers || {};
    const combo = typeof layers.menuKey === 'string' && layers.menuKey ? layers.menuKey : 'alt+shift+x';
    return window.DeckShortcuts && typeof window.DeckShortcuts.formatShortcut === 'function'
      ? window.DeckShortcuts.formatShortcut(combo) : combo;
  }

  // Only in the app on this PC, where the widgets can be drawn, and only once.
  function shouldAsk() {
    const caps = window.__XENON_NATIVE_CAPS__ || {};
    if (window.__XENON_NATIVE__ !== true || caps.layers !== true) return false;
    if (current()) return false;
    if (window.__xenonRemote) return false;
    if (typeof isLayerPage === 'function' && isLayerPage()) return false;
    try { if (window.self !== window.top) return false; } catch (e) { return false; }
    return true;
  }

  function displays() {
    const native = window.XenonNative;
    if (!native || typeof native.displayState !== 'function') return [];
    return native.displayState().displays || [];
  }

  // The shell pushes its screens a moment after the page loads, so this runs again then:
  // what was advised on no list at all may be wrong, unless the person already spoke.
  function read() {
    list = displays();
    advised = plan().advice(list);
    if (!touched || !plan().cards(list).includes(picked)) picked = advised;
    if (!tapped || !list.some((d) => d.id === dash)) dash = plan().dashScreen(list);
  }

  function nameById(id) {
    const display = list.find((d) => d.id === id);
    return display ? plan().nameOf(display, list) : '';
  }

  function bodyOf(mode) {
    const many = plan().several(list);
    const desk = nameById(plan().deskScreen(list, mode === 'both' ? dash : ''));
    const fill = (key, fallback) => tr(key, fallback).replace('{dash}', nameById(dash)).replace('{desk}', desk);
    if (mode === 'both') return fill('usage_ask_both_body', 'The dashboard on {dash}, the widgets on {desk}.');
    if (mode === 'phone') return tr('usage_ask_phone_body', 'Widgets here, the dashboard on your phone or tablet over your Wi-Fi.');
    if (mode === 'widgets') {
      return many ? fill('usage_ask_widgets_body', 'Widgets on {desk}, over the desktop. No window.')
        : tr('usage_ask_widgets_one_body', 'Widgets on the desktop, over the wallpaper.');
    }
    return many ? fill('usage_ask_dash_body', 'The whole dashboard on {dash}.')
      : tr('usage_ask_dash_one_body', 'The dashboard in a window, like an app.');
  }

  function paint() {
    const movable = plan().several(list) && (picked === 'both' || picked === 'dashboard');
    overlay.querySelectorAll('.ua-card').forEach((b) => {
      const on = b.dataset.mode === picked;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.querySelector('.ua-body').textContent = bodyOf(b.dataset.mode);
    });
    picture.paint({ shows: plan().scene({ mode: picked, list, dash }), dash, phoneOn: picked === plan().PHONE, movable });
    overlay.querySelector('.ua-hint').classList.toggle('is-on', movable);
  }

  function focusChosen() {
    const on = overlay && overlay.querySelector('.ua-card.is-on');
    if (on) on.focus();
  }

  function choose(mode) {
    picked = mode;
    touched = true;
    paint();
    focusChosen();
  }

  function row(mode) {
    const b = el('button', 'ua-card');
    b.type = 'button';
    b.dataset.mode = mode;
    b.setAttribute('role', 'radio');
    const title = el('span', 'ua-row-title');
    title.append(el('b', '', tr(TITLE[mode], mode)));
    if (mode === advised) title.append(el('span', 'ua-rec', tr('usage_ask_recommended', 'Recommended')));
    const words = el('span', 'ua-words');
    words.append(title, el('span', 'ua-body'));
    b.append(el('span', 'ua-ring'), words);
    b.addEventListener('click', () => choose(mode));
    b.addEventListener('dblclick', () => confirm());
    return b;
  }

  // Rows and picture depend on the list of screens, so both are redrawn with it.
  function fill() {
    overlay.querySelector('.ua-cards').replaceChildren(...plan().cards(list).map(row));
    picture.draw(list);
    overlay.querySelector('.ua-phone').classList.toggle('is-on', plan().several(list));
    paint();
  }

  function subLine() {
    const sub = el('p', 'ua-sub');
    // The key combination never breaks across lines ("Alt + Shift" / "+ X").
    const [before, after = ''] = tr('usage_ask_sub', 'Change it any time from the Xenon menu ({key}) or by asking Bit.').split('{key}');
    sub.append(el('span', '', before), el('span', 'ua-key', menuKeyText()), el('span', '', after));
    return sub;
  }

  function phoneLine() {
    const line = el('p', 'ua-phone', tr('usage_ask_phone_line', 'Want the dashboard on a phone or tablet?'));
    const go = el('button', 'ua-phone-go', tr('usage_ask_phone_go', 'Set it up'));
    go.type = 'button';
    go.addEventListener('click', () => confirm(plan().PHONE));
    line.append(' ', go);
    return line;
  }

  function mountBit(host) {
    if (!window.BitApp || typeof window.BitApp.mount !== 'function') return;
    const hold = window.BitApp.TILE_HOLD.filter((name) => name !== 'overlay-frozen');
    bit = window.BitApp.mount(host, { mood: 'idle', fidgets: true, calm: true, label: 'Bit', hold });
    if (bit && window.BootSplash) window.BootSplash.whenGone(() => { if (bit) bit.play('hello'); });
  }

  function build() {
    overlay = el('div', 'sp-overlay ua-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ua-title');
    picture = window.UsageAskPicture.create({
      nameOf: plan().nameOf,
      tapLabel: (name) => tr('usage_ask_screen_aria', 'Put the dashboard on {name}').replace('{name}', name),
      onTap: (id) => { dash = id; tapped = true; paint(); },
    });
    const left = el('div', 'ua-left');
    left.append(picture.node, el('p', 'ua-hint', tr('usage_ask_screen_hint', 'Tap a screen to put the dashboard there.')));
    const head = el('div', 'ua-head');
    const face = el('span', 'sp-bit');
    const title = el('h2', '', tr('usage_ask_title', 'How do you want to use Xenon?'));
    title.id = 'ua-title';
    head.append(face, title);
    const cards = el('div', 'ua-cards');
    cards.setAttribute('role', 'radiogroup');
    cards.setAttribute('aria-labelledby', 'ua-title');
    const go = el('button', 'ua-go', tr('usage_ask_go', 'Continue'));
    go.type = 'button';
    go.addEventListener('click', () => confirm());
    const right = el('div', 'ua-right');
    right.append(head, subLine(), cards, go, phoneLine());
    const box = el('div', 'ua-box');
    box.append(left, right);
    overlay.append(box);
    document.body.appendChild(overlay);
    mountBit(face);
  }

  function close() {
    if (!overlay) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    overlay = null;
    picture = null;
    if (bit && window.BitApp) window.BitApp.sweep();
    bit = null;
    document.body.classList.remove('first-run-asking');
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('usage-ask', false);
  }

  // The menu is the way in once widgets are on the screen, and it shows its key
  // at the top: opening it once teaches the key better than a line of text.
  function showMenu() {
    if (!(window.__XENON_NATIVE_CAPS__ || {}).menu) return;
    fetch(SERVER + '/screen-menu', {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{"open":true,"section":"widgets"}',
    }).catch((e) => console.warn('[usage-ask] the Xenon menu did not open', e));
  }

  function placeDashboard(answer) {
    if (answer.phone) { window.SurfacePicker.setUpPhone(); return; }
    if (typeof window.setSurfaceChoice === 'function') window.setSurfaceChoice({ ...answer.surface, asked: true });
    const native = window.XenonNative;
    if (answer.dash && native && typeof native.chooseScreen === 'function') {
      native.chooseScreen(answer.dash, native.displayState().fullscreen);
    }
  }

  // One at a time: each looks at the places the last one took.
  async function placeStarters(answer) {
    for (const action of plan().starters(answer, list)) {
      try {
        const res = await fetch(SERVER + '/actions/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action),
        });
        const done = await res.json();
        if (!done || done.ok !== true) console.warn('[usage-ask] not placed: ' + action.widget, done && done.error);
      } catch (e) {
        console.warn('[usage-ask] not placed: ' + action.widget, e);
      }
    }
  }

  // With the tour gone from the first run, this is how the side buttons get seen.
  function peekRails() {
    const rails = window.TopbarMinimal;
    if (!rails || typeof rails.peekRails !== 'function') return;
    rails.peekRails(true);
    setTimeout(() => rails.peekRails(false), RAILS_PEEK_MS);
  }

  async function confirm(mode = picked) {
    if (leaving) return;
    leaving = true;
    const answer = plan().answer({ mode, list, dash });
    await window.XenonMelt(close); // the dialog melts into what the person just chose
    placeDashboard(answer);
    // Before the mode: 'widgets' trades this page for the small driver page.
    await placeStarters(answer);
    const saved = typeof updateUsageMode === 'function' ? updateUsageMode(answer.usage) : null;
    if (answer.usage !== 'dashboard' && !answer.phone) showMenu();
    if (answer.usage !== 'widgets' && !answer.phone) peekRails();
    await saved;
    leaving = false;
  }

  // Arrows move the choice like any radio group; Enter confirms, unless it is on a screen or
  // the phone key, which have their own click. No Esc: the question has no "later", and the
  // preselected answer is one tap away.
  function onKey(e) {
    if (!overlay) return;
    overlay.classList.add('is-keyed');
    const modes = plan().cards(list);
    const i = modes.indexOf(picked);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') choose(modes[(i + 1) % modes.length]);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') choose(modes[(i + modes.length - 1) % modes.length]);
    else if (e.key === 'Enter' && !e.repeat) {
      if (e.target && e.target.closest && e.target.closest('.ua-screen, .ua-phone-go')) return;
      e.preventDefault();
      confirm();
      return;
    } else return;
    e.preventDefault();
  }

  function open() {
    touched = false;
    tapped = false;
    leaving = false;
    read();
    build();
    fill();
    document.addEventListener('keydown', onKey, true);
    document.body.classList.add('first-run-asking');
    if (window.XenonToast) window.XenonToast.dismissAll();
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('usage-ask', true);
    focusChosen();
  }

  // `returning`: this is an update, not a new install.
  function maybeStart({ returning = false } = {}) {
    if (overlay || !shouldAsk()) return !!overlay;
    if (returning) {
      if (typeof updateUsageMode === 'function') updateUsageMode('both');
      return false;
    }
    open();
    return true;
  }

  function onDisplays() {
    if (!overlay || leaving) return;
    read();
    fill();
    focusChosen();
  }

  window.UsageAsk = { maybeStart, shouldAsk, onDisplays, isOpen: () => !!overlay, close };
})();
