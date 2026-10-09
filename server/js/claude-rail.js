'use strict';
// The Claude tile's session rail: one card per Claude Code session, the one
// that needs you first. Each card is the answer to "which chat is doing what"
// at a glance — a Clawd in the session's own colour, moving the way the
// session is (walking = working, hopping = blocked on you, blinking = done,
// asleep = ended), its title, where it lives, and the one line of what it is
// doing right now. Tapping a card puts that session in the console beside it.
//
// On a narrow tile the same cards become a strip of chips above the console
// (CSS only, ClaudeWidget.css), so there is one list to keep right, not two.
//
// Untrusted text (titles, tool details, branch names) only ever reaches the
// page through textContent, via the el() factory.
(function () {
  const ORDER = { needs: 0, working: 1, idle: 2, ended: 3 };

  function stateOf(s) {
    if (s.ended) return 'ended';
    if (s.waitFor || s.state === 'waiting') return 'needs';
    if (s.state === 'running') return 'working';
    return 'idle';
  }

  // Needs-you first (longest waiting on top), then working, then the rest by
  // how recently they did something.
  function sort(list) {
    return list.slice().sort((a, b) => {
      const d = ORDER[stateOf(a)] - ORDER[stateOf(b)];
      if (d) return d;
      if (a.waitFor && b.waitFor) return (b.waitFor.forMs || 0) - (a.waitFor.forMs || 0);
      return (a.ageMs || 0) - (b.ageMs || 0);
    });
  }

  /**
   * @param {object} h
   * @param {Function} h.el  DOM factory (utils.js makeEl)
   * @param {Function} h.t   i18n
   * @param {object} s       live session record
   * @param {{title:string, sub:string[], slot:number}} who  from ClaudeIdent.describe
   */
  function card(h, s, who, opts) {
    const st = stateOf(s);
    const row = h.el('div', 'cw-rc is-' + st + ' is-s' + who.slot
      + (opts.selected ? ' is-sel' : '') + (opts.fresh ? ' is-fresh' : '') + (s.inferred ? ' is-inferred' : ''));
    row.tabIndex = 0;
    row.setAttribute('role', 'tab');
    row.setAttribute('aria-selected', opts.selected ? 'true' : 'false');
    row.dataset.session = s.id || '';
    const pick = () => h.onSelect(s.id, s.project || '');
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); }
    });

    const mascot = h.el('span', 'cw-rc-clawd cw-clawd is-' + st);
    mascot.appendChild(window.ClaudeClawd.make('cw-clawd-svg'));
    // The state in words for a screen reader and for whoever cannot tell the
    // motion or the colours apart; the badge carries it without motion.
    if (st === 'needs') mascot.appendChild(h.el('span', 'cw-clawd-badge is-needs', '!'));
    else if (opts.fresh) mascot.appendChild(h.el('span', 'cw-clawd-badge is-fresh'));
    row.appendChild(mascot);

    const main = h.el('div', 'cw-rc-main');
    const top = h.el('div', 'cw-rc-top');
    top.appendChild(h.el('span', 'cw-sr', h.stateLabel(s, st) + ':'));
    top.appendChild(h.el('span', 'cw-rc-title', who.title || '?'));
    top.appendChild(st === 'needs' && s.waitFor
      ? h.ageNode('cw-rc-clock', s.waitFor.forMs, '')
      : h.ageNode('cw-rc-clock', s.ageMs, ''));
    main.appendChild(top);
    if (who.sub.length) main.appendChild(h.el('div', 'cw-rc-sub', who.sub.join(' · ')));
    const now = h.nowLine(s, st);
    now.classList.add('cw-rc-now');
    main.appendChild(now);
    const todos = Array.isArray(s.todos) ? s.todos : [];
    if (todos.length && st !== 'ended') {
      const done = todos.filter((x) => x.status === 'done').length;
      const bar = h.el('div', 'cw-rc-todo');
      bar.setAttribute('aria-hidden', 'true');
      todos.forEach((x) => bar.appendChild(h.el('span', 'cw-rc-todo-seg is-' + x.status)));
      bar.title = done + '/' + todos.length;
      main.appendChild(bar);
    }
    row.appendChild(main);
    return row;
  }

  /**
   * @param {object} h  { el, t, list, titles, selected, fresh:Set, onSelect,
   *                      ageNode, nowLine, stateLabel, finishedTitle, showFinished }
   */
  function render(h) {
    const rail = h.el('div', 'cw-rail-list');
    rail.setAttribute('role', 'tablist');
    rail.setAttribute('aria-label', h.t('claude_sessions', 'Sessions'));
    const all = Array.isArray(h.list) ? h.list : [];
    const active = sort(all.filter((s) => !s.resting));
    const resting = sort(all.filter((s) => s.resting));
    const draw = (s) => rail.appendChild(card(h, s, window.ClaudeIdent.describe(s, h.titles), {
      selected: s.id === h.selected,
      fresh: h.fresh.has(s.id),
    }));
    active.slice(0, 20).forEach(draw);
    if (resting.length) {
      rail.appendChild(h.finishedTitle(resting.length));
      // The selected one stays visible even when the group is folded, or the
      // console would show a session the rail no longer has.
      resting.slice(0, 20).forEach((s) => { if (h.showFinished || s.id === h.selected) draw(s); });
    }
    return rail;
  }

  window.ClaudeRail = { render, stateOf, sort };
})();
