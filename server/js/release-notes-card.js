'use strict';
// What changed in a patch or a minor, and an update that did not go through.
// On the dashboard they are a modal over the page; in "widgets only" a card in the
// corner that opens in place, because nothing there may cover the user's work
// until they ask (js/screen-release.js). Same rows, same words.
(function () {
  const REPORT_MOOD = 'work';
  const NEWS_MOOD = 'happy';
  const FAIL_MOOD = 'worry';
  const MAJOR_CLIP = 'hello';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(cls, text, onClick) {
    const node = el('button', cls, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function bit(parent, cls, clip) {
    const host = el('div', cls);
    parent.append(host);
    const X = window.Xenon;
    if (!X || !X.bitPlayer) return null;
    const reducedMotion = document.body.classList.contains('low-power-gpu') || document.body.classList.contains('perf-mode');
    const kind = X.bit && X.bit.clip(clip);
    const player = X.bitPlayer.mount(host, { mood: kind && kind.kind === 'mood' ? clip : 'idle', fidgets: false, label: 'Bit', reducedMotion });
    if (kind && kind.kind !== 'mood') player.play(clip);
    return player;
  }

  function rows(notes, text) {
    const list = el('div', 'rn-rows');
    for (const item of notes.news) {
      const news = el('div', 'rn-new');
      news.append(el('div', 'rn-new-name', text(item.title)));
      if (item.text) news.append(el('div', 'rn-new-line', text(item.text)));
      list.append(news);
    }
    for (const fix of notes.fixes) {
      const row = el('div', 'rn-fix');
      row.append(el('b', '', text(fix.area)), el('span', '', text(fix.text)));
      list.append(row);
    }
    return list;
  }

  function foot(link, main) {
    const node = el('div', 'rn-foot');
    node.append(link || el('span'), main);
    return node;
  }

  // One dialog over the page. Esc and the button close it; a click beside it does
  // not, because closing is what says "read".
  function modal(build, onClose) {
    const overlay = el('div', 'rn-overlay');
    const card = el('div', 'rn-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    let player = null;
    let done = false;
    function close() {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      if (player) player.destroy();
      overlay.remove();
      onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    player = build(card, close);
    overlay.append(card);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    const main = card.querySelector('.rn-main');
    if (main) main.focus({ focusVisible: false });   // the ring is for Tab: it opens by itself, nobody got here by keyboard
    return close;
  }

  function header(card, cls, title, line, clip) {
    const head = el('div', `rn-head ${cls}`);
    const words = el('div', 'rn-head-words');
    words.append(el('h2', 'rn-title', title));
    if (line) words.append(el('p', 'rn-line', line));
    head.append(words);
    card.setAttribute('aria-label', title);
    card.append(head);
    return bit(head, 'rn-bit', clip);
  }

  function notesTitle(notes) { return `Xenon ${window.XenonReleaseNotice.shortVersion(notes.version)}`; }
  const notesMood = (notes) => (notes.news.length ? NEWS_MOOD : REPORT_MOOD);

  // opts: { notes, text, tr, url, openUrl, onClose }
  function openNotes(opts) {
    const { notes, text, tr } = opts;
    return modal((card, close) => {
      const player = header(card, 'rn-head-notes', notesTitle(notes), window.XenonReleaseNotice.summary(notes, tr), notesMood(notes));
      const all = opts.url ? button('rn-link', tr('rn_all'), () => opts.openUrl(opts.url)) : null;
      card.append(rows(notes, text), foot(all, button('rn-main', tr('rn_ok'), close)));
      return player;
    }, opts.onClose);
  }

  function failWords(lr, tr) {
    const fill = (key, map) => Object.entries(map).reduce((s, [k, v]) => s.replace(`{${k}}`, v), tr(key));
    const first = lr.rolledBack === false ? tr('update_failed_not_rolled_back')
      : lr.from ? fill('rn_fail_line', { from: lr.from }) : tr('rn_fail_kept');
    return { first, second: lr.to ? fill('rn_fail_sub', { to: lr.to }) : tr('rn_fail_sub_plain') };
  }

  function failBody(lr, detail, tr) {
    const words = failWords(lr, tr);
    const body = el('div', 'rn-fail');
    body.append(el('p', 'rn-fail-first', words.first), el('p', 'rn-fail-second', words.second));
    const why = el('p', 'rn-fail-why', detail || '');
    why.hidden = true;
    body.append(why);
    const toggle = detail ? button('rn-link', tr('rn_fail_what'), () => { why.hidden = !why.hidden; }) : null;
    return { body, toggle };
  }

  // opts: { lastResult, detail, tr, onRetry, onClose }
  function openFailed(opts) {
    const { tr } = opts;
    return modal((card, close) => {
      const player = header(card, 'rn-head-fail', tr('rn_fail_title'), '', FAIL_MOOD);
      const { body, toggle } = failBody(opts.lastResult, opts.detail, tr);
      const retry = button('rn-main', tr('rn_retry'), () => { close(); opts.onRetry(); });
      card.append(body, foot(toggle, retry));
      return player;
    }, opts.onClose);
  }

  // ── The corner of "widgets only" ─────────────────────────────────
  function corner(cls, parts) {
    const card = el('div', `rn-corner ${cls}`);
    card.setAttribute('role', 'status');
    const player = bit(card, 'rn-corner-bit', parts.clip);
    const words = el('div', 'rn-corner-words');
    words.append(el('div', 'rn-corner-title', parts.title), el('div', 'rn-corner-line', parts.line));
    card.append(words, button('rn-corner-go', parts.action, parts.onGo));
    document.body.append(card);
    return () => { if (player) player.destroy(); card.remove(); };
  }

  function expand(title, line, clip, fill) {
    const card = el('div', 'rn-corner is-open');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', title);
    const top = el('div', 'rn-corner-top');
    const player = bit(top, 'rn-corner-bit', clip);
    const words = el('div', 'rn-corner-words');
    words.append(el('div', 'rn-corner-title', title));
    if (line) words.append(el('div', 'rn-corner-line', line));
    top.append(words);
    card.append(top);
    fill(card);
    document.body.append(card);
    return () => { if (player) player.destroy(); card.remove(); };
  }

  // opts as openNotes. Closed with Ok only: the collapsed card waits as long as
  // it takes, since seeing it is the only thing that ends it.
  function cornerNotes(opts) {
    const { notes, text, tr } = opts;
    const count = notes.fixes.length;
    const line = notes.news.length ? window.XenonReleaseNotice.summary(notes, tr)
      : count === 1 ? tr('rn_card_fixed_one') : tr('rn_card_fixed_n').replace('{n}', String(count));
    const remove = corner('', {
      clip: notesMood(notes), title: notesTitle(notes), line, action: tr('rn_see'),
      onGo: () => {
        remove();
        const gone = expand(notesTitle(notes), window.XenonReleaseNotice.summary(notes, tr), notesMood(notes), (card) => {
          const all = opts.url ? button('rn-link', tr('rn_all'), () => opts.openUrl(opts.url)) : null;
          card.append(rows(notes, text), foot(all, button('rn-main', tr('rn_ok'), () => { gone(); opts.onClose(); })));
        });
      },
    });
    return remove;
  }

  // opts: { name, line, tr, onOpen }
  function cornerMajor(opts) {
    const remove = corner('rn-corner-major', {
      clip: MAJOR_CLIP, title: opts.name, line: opts.line, action: opts.tr('rn_watch'),
      onGo: () => { remove(); opts.onOpen(); },
    });
    return remove;
  }

  // opts as openFailed.
  function cornerFailed(opts) {
    const { tr } = opts;
    const gone = expand(tr('rn_fail_title'), '', FAIL_MOOD, (card) => {
      const { body, toggle } = failBody(opts.lastResult, opts.detail, tr);
      const retry = button('rn-main', tr('rn_retry'), () => { gone(); opts.onClose(); opts.onRetry(); });
      const later = button('rn-link', tr('rn_ok'), () => { gone(); opts.onClose(); });
      card.append(body, foot(toggle || later, retry));
      if (toggle) card.querySelector('.rn-foot').append(later);
    });
    return gone;
  }

  window.XenonReleaseNotes = Object.freeze({ bit, openNotes, openFailed, cornerNotes, cornerMajor, cornerFailed });
})();
