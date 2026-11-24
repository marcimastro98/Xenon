'use strict';

// The Fans section of the Xenon menu (rows from server/menu/menu-airflow.js): at the top
// what the fans do now and why, the check's progress, the score while Xenon only watches,
// the first steps and the buttons for the next one, how Airflow thinks; under it four
// tabs. The switches and choices inside the tabs are the menu's own rows (`row`). Every fan is a card with its
// speed and who drives it; a tap opens its choices. While the Fans tab shows, the speeds
// are read again every POLL_MS (GET /airflow): they move every second, and a change of
// hands or reason reloads the whole menu anyway (SSE `airflow`). Which tab and which fan
// are open belong to this page and survive the menu's rebuilds.
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuAirflow = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const POLL_MS = 2000;
  const COPIED_MS = 2000;

  // ctx: { el, button, say, tt, fill, icon, perform, server, row(r) → node }
  function create(ctx) {
    const { el, button, say, tt, fill, icon, perform, server } = ctx;
    let tab = 'now';
    let openFan = '';
    let howOpen = null; // the person's own open or close of 'How Airflow thinks', else the row's default
    let emptyOpen = false; // the group of empty headers on the Fans tab
    let page = null;   // the drawn page, while it is in the document
    let shown = null;  // its row, for a tab or a fan chosen here
    let timer = 0;
    let reading = false;

    const number = (n) => Number(n).toLocaleString(tt('locale') || undefined);

    function actions(r, list) {
      const box = el('div', 'xm-acts xm-air-acts');
      for (const a of list || []) {
        const b = button('ui-btn ' + (a.primary ? 'ui-btn--primary' : 'ui-btn--secondary') + ' xm-act', say(a.label));
        b.addEventListener('click', () => perform(r, a.act));
        box.appendChild(b);
      }
      return box;
    }

    // The line to paste on Linux: shown whole, selectable, with a copy button.
    function command(text) {
      const box = el('div', 'xm-air-cmd');
      const code = el('code', 'xm-air-code', text);
      const copy = button('ui-btn ui-btn--secondary xm-act', tt('airflow_btn_copy'));
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = tt('airflow_copied');
          setTimeout(() => { copy.textContent = tt('airflow_btn_copy'); }, COPIED_MS);
        } catch {
          // No clipboard here (a page that is not secure): the line stays selectable.
          const range = document.createRange();
          range.selectNodeContents(code);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
        }
      });
      box.append(code, copy);
      return box;
    }

    function head(r) {
      const h = r.head;
      const box = el('section', 'xm-air-head xm-tone-' + (h.tone || 'none'));
      box.appendChild(el('h3', 'xm-air-title', say(h.title)));
      // What was found is one line per place, each its own sentence.
      for (const l of Array.isArray(h.line) ? h.line : [h.line]) {
        const line = say(l);
        if (line) box.appendChild(el('p', 'xm-air-line', line));
      }
      if (Number.isFinite(h.progress)) {
        const bar = el('progress', 'xm-air-progress');
        bar.max = 100;
        bar.value = h.progress;
        bar.setAttribute('aria-label', say(h.title));
        box.appendChild(bar);
      }
      if (h.score) {
        const list = el('ul', 'xm-air-score');
        list.append(...h.score.map((s) => el('li', '', say(s))));
        box.appendChild(list);
      }
      if (h.ended) box.appendChild(el('p', 'xm-air-line xm-tone-' + h.ended.tone, say(h.ended.text)));
      // Fans that stay with the PC while the rest are driven: which, then why.
      for (const [i, l] of (h.part || []).entries()) box.appendChild(el('p', 'xm-air-line' + (i ? '' : ' xm-tone-warn'), say(l)));
      if (h.command) box.appendChild(command(h.command));
      if (h.actions?.length) box.appendChild(actions(r, h.actions));
      return box;
    }

    // Find, check, watch, drive: the ones done, the one now, and what it means.
    function steps(s) {
      const box = el('div', 'xm-air-steps');
      const list = el('ol', 'xm-air-steplist');
      list.append(...s.list.map((label, i) => {
        const li = el('li', i < s.at ? 'is-done' : i === s.at ? 'is-now' : '', say(label));
        if (i === s.at) li.setAttribute('aria-current', 'step');
        return li;
      }));
      box.append(list, el('p', 'xm-air-line', say(s.sub)));
      return box;
    }

    // How Airflow thinks: seven short points, each a name and one or two sentences.
    function how(h) {
      const box = el('details', 'xm-air-how');
      box.open = howOpen ?? !!h.open;
      const sum = el('summary', 'xm-air-howtitle', say(h.title));
      sum.dataset.keep = 'airflow-how';
      const list = el('dl', 'xm-air-howlist');
      for (const p of h.points) list.append(el('dt', '', say(p.title)), el('dd', '', say(p.text)));
      box.append(sum, list, el('p', 'xm-air-line', say(h.foot)));
      box.addEventListener('toggle', () => { howOpen = box.open; });
      return box;
    }

    function tabBar(r) {
      const bar = el('div', 'xm-wtabs xm-air-tabs');
      bar.setAttribute('role', 'tablist');
      bar.append(...r.tabs.map((t) => {
        const b = button('xm-wtab');
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(t.id === tab));
        b.dataset.keep = 'airflow-tab:' + t.id;
        b.appendChild(el('span', 'xm-wtab-name', say(t.label)));
        b.addEventListener('click', () => { tab = t.id; redrawHere(r); });
        return b;
      }));
      return bar;
    }

    function speedText(f) {
      const parts = [];
      if (Number.isFinite(f.rpm)) parts.push(fill(tt('airflow_rpm'), { n: number(f.rpm) }));
      if (Number.isFinite(f.duty)) parts.push(fill(tt('airflow_duty'), { n: number(f.duty) }));
      return parts.join(' · ');
    }

    function fanCard(f) {
      const card = el('div', 'xm-air-fan' + (openFan === f.id ? ' is-open' : ''));
      card.dataset.fan = f.id;
      const top = button('xm-air-fantop');
      top.setAttribute('aria-expanded', String(openFan === f.id));
      top.dataset.keep = 'airflow-fan:' + f.id;
      const mark = icon(f.kind === 'pump' ? 'drop' : 'fan');
      if (mark) top.appendChild(mark);
      const words = el('span', 'xm-words');
      words.appendChild(el('span', 'xm-label', say(f.name)));
      if (f.note) words.appendChild(el('span', 'xm-sub xm-tone-' + f.note.tone, say(f.note.text)));
      top.append(words, el('span', 'xm-air-speed', speedText(f)), el('span', 'xm-air-by is-' + f.by, tt('airflow_by_' + f.by)));
      top.addEventListener('click', () => { openFan = openFan === f.id ? '' : f.id; redrawHere(shown); });
      card.appendChild(top);
      if (openFan === f.id) {
        const rows = el('div', 'xm-list xm-air-fanrows');
        for (const x of f.rows) { const n = ctx.row(x); if (n) rows.appendChild(n); }
        card.appendChild(rows);
      }
      return card;
    }

    function panel(t) {
      if (t.fans) {
        const box = el('div', 'xm-air-fans');
        box.setAttribute('role', 'tabpanel');
        if (!t.fans.length) box.appendChild(el('p', 'xm-empty', tt('airflow_no_fans')));
        else if (t.intro) box.appendChild(el('p', 'xm-air-line', say(t.intro)));
        box.append(...t.fans.filter((f) => !f.empty).map(fanCard));
        // Headers with nothing plugged in: out of the way, closed, still reachable.
        const empty = t.fans.filter((f) => f.empty);
        if (empty.length) {
          const group = el('details', 'xm-air-fold xm-air-emptyfans');
          group.open = emptyOpen;
          const sum = el('summary', 'xm-air-howtitle', fill(tt('airflow_fans_empty'), { n: empty.length }));
          sum.dataset.keep = 'airflow-empty';
          group.append(sum, ...empty.map(fanCard));
          group.addEventListener('toggle', () => { emptyOpen = group.open; });
          box.appendChild(group);
        }
        return box;
      }
      const list = el('div', 'xm-list');
      list.setAttribute('role', 'tabpanel');
      for (const x of t.rows) { const n = ctx.row(x); if (n) list.appendChild(n); }
      return list;
    }

    function fillPage(box, r) {
      shown = r;
      box.replaceChildren(head(r));
      if (r.steps) box.appendChild(steps(r.steps));
      if (r.how) box.appendChild(how(r.how));
      if (!r.tabs.length) return;
      if (!r.tabs.some((t) => t.id === tab)) tab = r.tabs[0].id;
      box.append(tabBar(r), panel(r.tabs.find((t) => t.id === tab)));
    }
    // A tab or a fan chosen here: only this page changes, the menu is not asked again, and
    // what was tapped keeps the keyboard.
    function redrawHere(r) {
      const keep = page?.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.keep : '';
      if (page && r) fillPage(page, r);
      if (keep) [...page.querySelectorAll('[data-keep]')].find((n) => n.dataset.keep === keep)?.focus();
      watch();
    }

    // The speeds of the fans on the Fans tab, read again while it shows.
    async function readSpeeds() {
      if (reading) return;
      reading = true;
      try {
        const res = await fetch(server + '/airflow', { cache: 'no-store' });
        const d = res.ok ? await res.json() : null;
        if (!d?.ok || !page) return;
        for (const f of d.fans || []) {
          const card = [...page.querySelectorAll('[data-fan]')].find((n) => n.dataset.fan === f.id);
          if (!card) continue;
          const speed = card.querySelector('.xm-air-speed');
          if (speed) speed.textContent = speedText({ rpm: Number.isFinite(f.rpm) ? Math.round(f.rpm) : null, duty: Number.isFinite(f.duty) ? Math.round(f.duty) : null });
          const by = card.querySelector('.xm-air-by');
          if (by) { by.className = 'xm-air-by is-' + (f.xenon ? 'xenon' : 'pc'); by.textContent = tt(f.xenon ? 'airflow_by_xenon' : 'airflow_by_pc'); }
        }
      } catch { /* the next read tries again; the menu says when the server is gone */ }
      finally { reading = false; }
    }

    function stop() {
      clearInterval(timer);
      timer = 0;
    }

    function tick() {
      if (!page?.isConnected) { stop(); return; }
      if (document.visibilityState === 'visible') readSpeeds();
    }

    function watch() {
      if (tab === 'fans' && !timer) timer = setInterval(tick, POLL_MS);
      if (tab !== 'fans') stop();
    }

    function draw(r) {
      const box = el('div', 'xm-air xm-air--' + (r.state || 'off'));
      box.dataset.row = r.id;
      page = box;
      fillPage(box, r);
      watch();
      return box;
    }

    return { draw, stop };
  }

  return { create, POLL_MS };
});
