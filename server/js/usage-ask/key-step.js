'use strict';

// The first run's last step, where this app draws Xenon over the screen: "press the key".
// Pressing it once teaches it better than a line saying it (Raycast has you press its key
// during setup). The shell takes the combination before this page sees it, so the press is
// known from the server, which opens Xenon and says so on SSE `screen_menu` (js/grid/data-stream.js
// calls onMenu). What the page does see are the modifiers held down: their chips light up.
// After LATE_MS with no press the step offers another key: the combination may belong to
// another app. Resolves 'pressed', 'later' or 'other'.
(() => {
  const DONE_MS = 1800;   // "That's it" stays this long, then the dialog melts
  const NAMES = { Alt: 'alt', AltGraph: 'alt', Shift: 'shift', Control: 'ctrl', Meta: 'win', OS: 'win' };

  let step = null;   // { root, chips, resolve, timer, done }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(className, text, onClick) {
    const b = el('button', className, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // The part of the combination a key event is, in the words of deck-shortcuts.js.
  function partOf(e) {
    if (NAMES[e.key]) return NAMES[e.key];
    const code = String(e.code || '');
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit\d$/.test(code)) return code.slice(5);
    return String(e.key || '').toLowerCase();
  }

  function onKey(e) {
    if (!step || step.done) return;
    if (e.type === 'keydown' && e.key === 'Escape') { e.preventDefault(); finish('later'); return; }
    const part = partOf(e);
    step.chips.forEach((chip) => { if (chip.dataset.part === part) chip.classList.toggle('is-down', e.type === 'keydown'); });
  }

  // The window lost the keys (Xenon opening takes the focus): nothing is held any more.
  function onBlur() {
    if (step && !step.done) step.chips.forEach((chip) => { chip.classList.remove('is-down'); });
  }

  function listen(on) {
    const how = on ? 'addEventListener' : 'removeEventListener';
    document[how]('keydown', onKey, true);
    document[how]('keyup', onKey, true);
    window[how]('blur', onBlur);
  }

  // Ends the step: by hand (Esc, the two buttons, all gone once it is done) or after "That's it".
  function finish(how) {
    if (!step) return;
    const { resolve, timer } = step;
    clearTimeout(timer);
    listen(false);
    step = null;
    resolve(how);
  }

  // The chips: one per part, labelled as the person reads them ("Option" on a Mac).
  function keys(ctx) {
    const row = el('div', 'uak-keys');
    const label = ctx.format(ctx.combo);
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', label);
    const parts = String(ctx.combo).split('+');
    label.split(' + ').forEach((text, i) => {
      if (i) row.append(el('span', 'uak-plus', '+'));
      const chip = el('span', 'uak-key', text);
      chip.dataset.part = parts[i] || '';
      row.append(chip);
    });
    return row;
  }

  function pressed() {
    if (!step || step.done) return;
    step.done = true;
    clearTimeout(step.timer);
    const { root, title, chips, tr } = step;
    root.classList.add('is-done');
    chips.forEach((chip) => { chip.classList.add('is-down'); });
    title.textContent = tr('usage_key_done', "That's it.");
    root.querySelector('.uak-line').textContent = tr('usage_key_done_line', 'This is how Xenon opens from any app.');
    root.querySelectorAll('.uak-late, .uak-later').forEach((n) => { n.hidden = true; });
    setTimeout(() => finish('pressed'), DONE_MS);
  }

  // Xenon opened or closed over the screen (SSE `screen_menu`).
  function onMenu(d) {
    if (step && d && d.open === true) pressed();
  }

  // host: the dialog's column (its .ua-head stays, its title changes); ctx: { tr, combo,
  // format(combo) }. Everything under the head is replaced: the question has been answered.
  function run(host, ctx) {
    if (step) finish('later');
    const title = host.querySelector('.ua-head h2');
    title.textContent = ctx.tr('usage_key_title', 'Last thing: open Xenon');
    const root = el('div', 'uak');
    const late = el('p', 'uak-late');
    late.hidden = true;
    late.setAttribute('aria-live', 'polite');
    late.append(el('span', '', ctx.tr('usage_key_stuck', 'Nothing happens?') + ' '),
      button('ua-phone-go', ctx.tr('usage_key_other', 'Choose another shortcut'), () => { if (step && !step.done) finish('other'); }));
    const later = button('uak-later', ctx.tr('usage_key_later', "I'll do it later"), () => { if (step && !step.done) finish('later'); });
    const row = keys(ctx);
    const line = el('p', 'ua-sub uak-line', ctx.tr('usage_key_line', 'Press these keys. They open Xenon over any app.'));
    line.setAttribute('aria-live', 'polite');
    root.append(line, row, late, later);
    [...host.children].forEach((n) => { if (!n.classList.contains('ua-head')) n.remove(); });
    host.append(root);
    return new Promise((resolve) => {
      step = { root, title, chips: [...row.querySelectorAll('.uak-key')], resolve, done: false, tr: ctx.tr };
      step.timer = setTimeout(() => { late.hidden = false; }, api.LATE_MS);
      listen(true);
      // The step itself takes the focus, read out whole, never a button: a held Enter from
      // "Continue" would press it.
      root.tabIndex = -1;
      root.focus();
    });
  }

  const api = { LATE_MS: 20000, run, onMenu, isOn: () => !!step, cancel: () => finish('later') };
  window.UsageAskKey = api;
})();
