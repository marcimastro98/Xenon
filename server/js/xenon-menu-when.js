'use strict';

// "When it shows", in the Xenon menu: always, only during some situations, or never
// during them, and for a page whether it comes forward by itself. A situation is one tap;
// the four that need a value open one small line under the chips. Every change is the
// rule as text (js/layer-when.js) sent through the row's own capability.
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const rules = node ? require('./layer-when.js') : root.LayerWhen;
  const place = node ? require('./xenon-menu-place.js') : root.XenonMenuPlace;
  const api = factory(rules, place);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuWhen = api;
})(typeof window !== 'undefined' ? window : globalThis, function (W, Place) {
  const NEEDS_VALUE = Object.freeze(['app', 'appOpen', 'battery', 'time']);
  // What most people want; the rest waits behind one tap.
  const FIRST = Object.freeze(['game', 'music', 'app']);
  const FIRST_BATTERY = 20;
  const FIRST_SPAN = Object.freeze({ from: '09:00', to: '18:00' });
  const WEEK = Object.freeze([1, 2, 3, 4, 5, 6, 0]);
  const A_SUNDAY = 1;   // 1 Nov 2026, to name the days in the person's language
  // "Only when" with nothing chosen yet is a choice in progress, not a rule.
  const DRAFT_MS = 60000;

  const dayName = (d, lang) => new Intl.DateTimeFormat(lang || undefined, { weekday: 'short' }).format(new Date(2026, 10, A_SUNDAY + d));
  const pageLang = () => (typeof document !== 'undefined' && document.documentElement.lang) || undefined;

  // ctx: { el, button, say, tt, fill, rowShell, perform, post, showError, redraw }
  function create(ctx) {
    const { el, button, say, tt, fill, rowShell, perform, post, showError, redraw } = ctx;
    const local = new Map();   // row id -> the rule as the person left it, until the server has it
    let detail = '';           // "<row id>:<situation>" whose small line is open
    const opened = new Set();  // the rows showing every situation
    let apps = null;           // the apps open now, null while asked for
    const faces = new Map();   // app key -> its picture, once the list has told
    let queue = Promise.resolve();

    function ruleOf(r) {
      if (!local.has(r.id)) return r.rule;
      const mine = local.get(r.id);
      if (!mine || !mine.at || Date.now() - mine.at < DRAFT_MS) return mine;
      local.delete(r.id);
      return r.rule;
    }

    // One after the other: two quick taps must both arrive, the last one winning. A rule
    // left empty is saved as "always" but stays open, so another situation can be picked.
    function write(r, rule) {
      const plain = rule && { ...(rule.hide ? { hide: true } : {}), any: rule.any };
      const empty = !!plain && !plain.any.length;
      const kept = empty ? { ...plain, at: Date.now() } : plain;
      local.set(r.id, kept);
      redraw();
      queue = queue.then(async () => {
        const ok = await perform(r, { run: { ...r.set, when: W.format(W.normalize(plain)) } });
        if (empty && ok) return;
        if (local.get(r.id) === kept) local.delete(r.id);
        if (!ok) redraw();
      });
    }

    function chip(label, on, keep, press) {
      const b = button('xm-choice', label);
      b.setAttribute('aria-pressed', String(on));
      b.dataset.keep = keep;
      b.addEventListener('click', press);
      return b;
    }

    function chips(label, list) {
      const group = el('div', 'xm-choices');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      group.append(...list);
      return group;
    }

    function pickMode(r, rule, mode) {
      detail = '';
      if (mode === 'always') { write(r, null); return; }
      const any = rule ? rule.any : [];
      const next = { ...(mode === 'hide' ? { hide: true } : {}), any };
      if (any.length) { write(r, next); return; }
      local.set(r.id, { ...next, at: Date.now() });
      redraw();
    }

    function modeChips(r, rule) {
      const now = !rule ? 'always' : rule.hide ? 'hide' : 'only';
      const modes = r.page
        ? [['always', 'xmenu_when_page_off'], ['only', 'xmenu_when_page_on']]
        : [['always', 'xmenu_when_always'], ['only', 'xmenu_when_only'], ['hide', 'xmenu_when_hide']];
      // Under the cards "always" is already one of the answers.
      const shown = r.answered ? modes.filter(([mode]) => mode !== 'always') : modes;
      return chips(say(r.label), shown.map(([mode, key]) => chip(tt(key), mode === now, `${r.id}:${mode}`, () => {
        if (mode !== now) pickMode(r, rule, mode);
      })));
    }

    const without = (rule, test) => ({ ...rule, any: rule.any.filter((x) => !test(x)) });
    const added = (rule, item) => ({ ...rule, any: [...rule.any, item] });
    const replaced = (rule, c, item) => ({ ...rule, any: rule.any.map((x) => (x.c === c ? item : x)) });

    async function askApps(key) {
      apps = null;
      redraw();
      const res = await post('/actions/run', { type: 'layerAnchor', mode: 'apps', pictures: 'on' }).catch(() => null);
      if (detail !== key) return;
      if (res && res.ok !== false) {
        apps = (res.apps || []).map((a) => a.app);
        for (const a of res.apps || []) if (a.icon) faces.set(W.appKey(a.app), a.icon);
      } else {
        detail = '';
        showError((res && res.error) || 'unavailable');
      }
      redraw();
    }

    function pressValued(r, rule, c) {
      const key = `${r.id}:${c}`;
      const closing = detail === key;
      detail = closing ? '' : key;
      const has = rule.any.some((x) => x.c === c);
      if (closing || (has && (c === 'battery' || c === 'time'))) redraw();
      else if (c === 'app' || c === 'appOpen') askApps(key);
      else if (c === 'battery') write(r, added(rule, { c, below: FIRST_BATTERY }));
      else write(r, added(rule, { c, ...FIRST_SPAN }));
    }

    // What a chip with a value says once it has one.
    function valueOf(rule, c) {
      const mine = rule.any.filter((x) => x.c === c);
      if (!mine.length) return '';
      if (c === 'battery') return fill(tt('xmenu_when_battery_below'), { n: mine[0].below });
      if (c === 'time') return `${mine[0].from}-${mine[0].to}`;
      return mine.map((x) => x.app).join(', ');
    }

    function situationChip(r, rule, s) {
      const on = rule.any.some((x) => x.c === s.c);
      const valued = NEEDS_VALUE.includes(s.c);
      const value = valued ? valueOf(rule, s.c) : '';
      const b = chip(value ? `${say(s.label)}: ${value}` : say(s.label), on, `${r.id}:${s.c}`, () => {
        if (valued) pressValued(r, rule, s.c);
        else write(r, on ? without(rule, (x) => x.c === s.c) : added(rule, { c: s.c }));
      });
      b.classList.add('xm-when-chip');
      if (!on && rule.any.length >= W.MAX_RULES) b.disabled = true;
      return b;
    }

    function appLine(r, rule, c) {
      const box = el('div', 'xm-when-line');
      if (apps === null) return box;
      const chosen = rule.any.filter((x) => x.c === c).map((x) => x.app);
      const seen = new Set(chosen);
      const others = apps.filter((name) => {
        const fresh = !seen.has(W.appKey(name));
        seen.add(W.appKey(name));
        return fresh;
      });
      box.appendChild(el('p', 'xm-sub', tt('xmenu_when_pick_app')));
      box.appendChild(chips(tt('xmenu_sit_' + c), [...chosen, ...others].map((name) => {
        const app = W.appKey(name);
        const on = chosen.includes(app);
        const b = chip(W.appName(name), on, `${r.id}:${c}:${app}`, () => {
          write(r, on ? without(rule, (x) => x.c === c && x.app === app) : added(rule, { c, app }));
        });
        const face = Place.picture(el, faces.get(app));
        if (face) { b.classList.add('xm-app'); b.prepend(face); }
        return b;
      })));
      return box;
    }

    const removeChip = (r, rule, c) => chip(tt('xmenu_remove'), false, `${r.id}:${c}:off`, () => {
      detail = '';
      write(r, without(rule, (x) => x.c === c));
    });

    function batteryLine(r, rule) {
      const now = rule.any.find((x) => x.c === 'battery');
      const box = el('div', 'xm-when-line');
      if (!now) return box;
      const levels = W.BATTERY_LEVELS.map((n) => chip(fill(tt('xmenu_when_battery_below'), { n }), now.below === n, `${r.id}:battery:${n}`, () => {
        if (now.below !== n) write(r, replaced(rule, 'battery', { c: 'battery', below: n }));
      }));
      box.appendChild(chips(tt('xmenu_sit_battery'), [...levels, removeChip(r, rule, 'battery')]));
      return box;
    }

    function clockField(label, value, change) {
      const wrap = el('label', 'xm-when-clock', label);
      const input = el('input');
      input.type = 'time';
      input.value = value;
      // On blur, not on change: change fires per digit, and writing redraws the row.
      input.addEventListener('blur', () => change(input.value));
      wrap.appendChild(input);
      return wrap;
    }

    function timeLine(r, rule) {
      const now = rule.any.find((x) => x.c === 'time');
      const box = el('div', 'xm-when-line');
      if (!now) return box;
      const set = (patch) => {
        const next = { ...now, ...patch };
        if (!next.from || !next.to || next.from === next.to) redraw();
        else if (next.from !== now.from || next.to !== now.to || patch.days) write(r, replaced(rule, 'time', next));
      };
      const hours = el('div', 'xm-when-hours');
      hours.append(clockField(tt('xmenu_when_from'), now.from, (from) => set({ from })), clockField(tt('xmenu_when_to'), now.to, (to) => set({ to })));
      const chosen = now.days || W.EVERY_DAY;
      const days = WEEK.map((d) => chip(dayName(d, pageLang()), chosen.includes(d), `${r.id}:time:${d}`, () => {
        const next = chosen.includes(d) ? chosen.filter((x) => x !== d) : [...chosen, d];
        if (next.length) set({ days: next });
      }));
      box.append(hours, chips(tt('xmenu_sit_time'), [...days, removeChip(r, rule, 'time')]));
      return box;
    }

    function detailLine(r, rule) {
      const c = detail.slice(r.id.length + 1);
      if (c === 'battery') return batteryLine(r, rule);
      return c === 'time' ? timeLine(r, rule) : appLine(r, rule, c);
    }

    function moreLink(r, hidden) {
      const b = button('xm-link xm-when-more', tt('xmenu_when_more'));
      // Named after the first chip it uncovers, so the focus lands there after the redraw.
      b.dataset.keep = `${r.id}:${hidden[0].c}`;
      b.addEventListener('click', () => { opened.add(r.id); redraw(); });
      return b;
    }

    // A situation already in the rule always stays in sight.
    function situations(r, rule) {
      const box = el('div', 'xm-place-apps');
      const inRule = (s) => rule.any.some((x) => x.c === s.c);
      const shown = r.situations.filter((s) => opened.has(r.id) || FIRST.includes(s.c) || inRule(s));
      const hidden = r.situations.filter((s) => !shown.includes(s));
      if (rule.any.length > 1) box.appendChild(el('p', 'xm-sub xm-place-ask', tt('xmenu_when_any')));
      const group = chips(say(r.label), shown.map((s) => situationChip(r, rule, s)));
      if (hidden.length) group.appendChild(moreLink(r, hidden));
      box.appendChild(group);
      if (detail.startsWith(r.id + ':')) box.appendChild(detailLine(r, rule));
      if (!hidden.length) for (const why of r.missing || []) box.appendChild(el('p', 'xm-sub', say(why)));
      return box;
    }

    // `start`: the person already said "at certain moments", so the situations are open
    // with "only when" until one is picked; nothing is saved before that.
    function draw(r) {
      const rule = ruleOf(r) || (r.start ? { any: [] } : null);
      const li = rowShell(r, 'xm-row--stack xm-row--place');
      li.appendChild(modeChips(r, rule));
      if (rule) li.appendChild(situations(r, rule));
      return li;
    }

    return { draw };
  }

  return { create };
});
