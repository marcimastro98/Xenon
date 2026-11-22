'use strict';

// The rows of a pump's tabs on the Screens page of the Xenon menu (server/menu/menu-pump.js
// and its two parts): a line per moment that opens on the faces to pick, drawn small as
// cards, then that face's choices; cards for the ring of lights and the ready-made examples;
// a short note over a tab; and the line that adds a moment. A face's look adds swatches, a
// colour, a picture and a line of text of the person's own (menu-pump-face-look.js). One line is open at a time, and
// it stays open through the menu's rebuild after a change, so the person sees what changed.
(() => {
  // Where the address of a picture the person sends goes in a line's save (menu-pump-faces.js).
  const FILE_MARK = 'xenon:file';
  // A face drawn small: its shape and a hint of what it shows. Decoration only.
  const MINI_TEXT = Object.freeze({ game: '144', clock: '10:42' });

  // The line's save with what the person sent (a picture's address, a colour, words) in place
  // of its mark: the patch is JSON text, the value goes in as a JSON string.
  function withMark(act, mark, value) {
    const run = act?.run;
    if (!run || typeof run.patch !== 'string') return null;
    return { run: { ...run, patch: run.patch.split(JSON.stringify(mark)).join(JSON.stringify(String(value))) } };
  }
  const withFile = (act, url) => withMark(act, FILE_MARK, url);

  // ctx: { el, button, say, perform, icon, DRAW, rowShell, upload, types, tryFace }
  //   upload(file) → { ok, url } or { ok: false, bad } (xenon-menu-pumps.js upload)
  //   tryFace(show, label): the pump's picture shows the open line; (null) its own face again
  function create(ctx) {
    const { el, button, say, perform, icon } = ctx;
    let open = '';
    let adding = false;
    const lines = new Map();   // line id -> { node, r }, as drawn last

    function mini(art, name) {
      const m = el('span', 'xm-pumpmini xm-pumpmini--' + art);
      m.setAttribute('aria-hidden', 'true');
      if (MINI_TEXT[art]) m.textContent = MINI_TEXT[art];
      else if (art === 'widget') m.textContent = String(name || '').charAt(0).toUpperCase();
      else m.appendChild(el('span', 'xm-pumpmini-in'));
      return m;
    }

    function chevron() {
      const c = icon('chevron') || el('span');
      c.classList.add('xm-pumpline-chev');
      return c;
    }

    // Opening a line closes the one open before; only those two are drawn again.
    function toggle(id) {
      const was = open;
      open = open === id ? '' : id;
      for (const key of [was, open]) {
        const line = key ? lines.get(key) : null;
        if (line?.node.isConnected) line.node.replaceWith(drawMoment(line.r));
      }
      if (!open && ctx.tryFace) ctx.tryFace(null);
      const head = lines.get(id)?.node.querySelector('.xm-pumpline-head');
      if (head) head.focus();
    }

    function faceCard(r, f) {
      const b = button('xm-pumpface');
      b.dataset.keep = `${r.id}:face:${f.value}`;
      b.setAttribute('aria-pressed', String(f.on === true));
      const name = say(f.label);
      b.append(mini(f.art, name), el('span', 'xm-pumpface-name', name));
      if (f.own) b.appendChild(el('span', 'xm-pumpface-tag', say(r.yours)));
      b.addEventListener('click', () => { if (f.act) perform(r, f.act); });
      return b;
    }

    function faceGrid(r) {
      const grid = el('div', 'xm-pumpfaces');
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', say(r.facesLabel));
      grid.append(...(r.faces || []).map((f) => faceCard(r, f)));
      return grid;
    }

    // A face of the person's own: the four ways to make or find one.
    function ownBox(r) {
      const box = el('div', 'xm-pumpownface');
      box.appendChild(el('p', 'xm-sub', say(r.own.label)));
      const acts = el('div', 'xm-pumpownface-acts');
      for (const a of r.own.actions) {
        const b = button('ui-btn ui-btn--secondary xm-act', say(a.label));
        const mark = a.icon && icon(a.icon);
        if (mark) b.prepend(mark);
        b.addEventListener('click', () => perform({ closes: a.closes }, a.act));
        acts.appendChild(b);
      }
      box.appendChild(acts);
      return box;
    }

    // "Use your own picture or GIF" (a picture line, a background): the file goes up, then the
    // line's save. up: { label, act }.
    function picker(id, up) {
      const wrap = el('div', 'xm-pumpown');
      const b = button('ui-btn ui-btn--secondary xm-act', say(up.label));
      b.dataset.keep = id + ':upload';
      const note = el('span', 'xm-pumpown-note');
      note.setAttribute('role', 'status');
      const input = el('input');
      input.type = 'file';
      input.accept = ctx.types || '';
      input.hidden = true;
      b.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        b.disabled = true;
        note.textContent = say({ key: 'xmenu_pump_own_busy' });
        try {
          const d = await ctx.upload(file);
          const act = d.ok ? withFile(up.act, d.url) : null;
          note.textContent = act ? '' : say({ key: d.bad ? 'xmenu_pump_own_bad' : 'xmenu_pump_own_failed' });
          if (act) await perform(up, act);
        } catch {
          note.textContent = say({ key: 'xmenu_pump_own_failed' });
        } finally {
          b.disabled = false;
        }
      });
      wrap.append(b, note, input);
      return wrap;
    }

    function openPart(r) {
      const parts = [el('span', 'xm-pumpline-cap', say(r.facesLabel)), faceGrid(r)];
      if (r.own) parts.push(ownBox(r));
      for (const x of r.rows || []) {
        const draw = LOOK[x.kind] || ctx.DRAW[x.kind];
        const node = draw ? draw(x) : null;
        if (node) parts.push(node);
      }
      if (r.remove) {
        const b = button('xm-pumpline-remove', say(r.remove.label));
        b.addEventListener('click', () => { open = ''; perform(r, r.remove.act); });
        parts.push(b);
      }
      return parts;
    }

    function drawMoment(r) {
      const on = open === r.id;
      const box = el('div', 'xm-pumpline' + (on ? ' is-open' : ''));
      box.dataset.row = r.id;
      const head = button('xm-pumpline-head');
      head.dataset.keep = r.id + ':head';
      head.setAttribute('aria-expanded', String(on));
      const words = el('span', 'xm-pumpline-words');
      words.appendChild(el('span', 'xm-label', say(r.label)));
      const sub = say(r.sub);
      if (sub) words.appendChild(el('span', 'xm-sub', sub));
      head.appendChild(words);
      const face = say(r.value);
      if (!on) head.append(mini(r.art, face), el('span', 'xm-pumpline-face', face));
      head.appendChild(chevron());
      head.addEventListener('click', () => toggle(r.id));
      box.appendChild(head);
      if (on) box.append(...openPart(r));
      if (on && ctx.tryFace && r.show) ctx.tryFace(r.show, r.label);
      lines.set(r.id, { node: box, r });
      return box;
    }

    const drawNote = (r) => el('p', 'xm-pumpnote', say(r.label));

    // Cards to choose from: each says what it does; the ring's are drawn with their colours.
    function drawCards(r) {
      const box = el('div', 'xm-pumpcards' + (r.plain ? ' is-plain' : ''));
      box.dataset.row = r.id;
      const words = el('div', 'xm-words');
      words.appendChild(el('span', 'xm-label', say(r.label)));
      const sub = say(r.sub);
      if (sub) words.appendChild(el('span', 'xm-sub', sub));
      const grid = el('div', 'xm-pumpcards-grid');
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', say(r.label));
      for (const c of r.cards || []) {
        const b = button('xm-pumpcard');
        b.dataset.keep = `${r.id}:${c.value}`;
        if (!r.plain) b.setAttribute('aria-pressed', String(c.on === true));
        if (c.art && !r.plain) b.appendChild(el('span', 'xm-pumpring xm-pumpring--' + String(c.art).replace(/^leds-/, '')));
        const text = el('span', 'xm-pumpcard-words');
        text.append(el('span', 'xm-pumpcard-name', say(c.label)), el('span', 'xm-sub', say(c.sub)));
        b.appendChild(text);
        b.addEventListener('click', () => { if (c.act) perform(r, c.act); });
        grid.appendChild(b);
      }
      box.append(words, grid);
      return box;
    }

    // "Add a moment": opens on the moments still free, one tap adds that line.
    function drawAdd(r) {
      const box = el('div', 'xm-pumpadd');
      box.dataset.row = r.id;
      const b = button('xm-pumpadd-head');
      b.dataset.keep = r.id + ':head';
      b.setAttribute('aria-expanded', String(adding));
      const words = el('span', 'xm-pumpline-words');
      words.appendChild(el('span', 'xm-label', say(r.label)));
      if (r.sub) words.appendChild(el('span', 'xm-sub', say(r.sub)));
      b.append(icon('plus') || '', words);
      b.addEventListener('click', () => { adding = !adding; const next = drawAdd(r); box.replaceWith(next); next.querySelector('.xm-pumpadd-head')?.focus(); });
      box.appendChild(b);
      if (adding) {
        const list = el('div', 'xm-choices xm-choices--multi xm-pumpadd-list');
        list.setAttribute('role', 'group');
        list.setAttribute('aria-label', say(r.label));
        for (const o of r.options || []) {
          const c = button('xm-choice', say(o.label));
          c.dataset.keep = `${r.id}:${o.value}`;
          c.addEventListener('click', () => { adding = false; perform(r, o.act); });
          list.appendChild(c);
        }
        box.appendChild(list);
      }
      return box;
    }

    // A colour set drawn as its four colours; 'picture' has none until the face shows one.
    function swatch(colors) {
      if (colors === undefined) return null;
      const dot = el('span', 'xm-pumpswatch' + (colors ? '' : ' is-picture'));
      dot.setAttribute('aria-hidden', 'true');
      // The set's colours are data: custom properties are the one way in.
      (colors || []).forEach((c, i) => { dot.style.setProperty('--sw' + (i + 1), c); });
      return dot;
    }

    // Keys of their own, a colour set's drawn beside its name; then, for colours, one of one's
    // own: the system's colour picker, saved when it closes.
    function drawKeys(r) {
      const li = ctx.rowShell(r, 'xm-row--stack');
      const group = el('div', 'xm-choices xm-choices--multi xm-pumpswatches');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', say(r.label));
      for (const o of r.options || []) {
        const b = button('xm-choice');
        b.dataset.keep = `${r.id}:${o.value}`;
        b.setAttribute('aria-pressed', String(o.on === true));
        const dot = swatch(o.swatch);
        if (dot) b.appendChild(dot);
        b.appendChild(el('span', '', say(o.label)));
        b.addEventListener('click', () => { if (o.act) perform(r, o.act); });
        group.appendChild(b);
      }
      if (r.own) group.appendChild(ownColor(r));
      li.appendChild(group);
      return li;
    }

    function ownColor(r) {
      const own = el('label', 'xm-choice xm-pumpswatch-own');
      own.classList.toggle('is-on', r.own.on === true);
      const input = el('input');
      input.type = 'color';
      input.value = r.own.value;
      input.addEventListener('change', () => { const act = withMark(r.own.act, r.mark, input.value); if (act) perform(r, act); });
      own.append(input, el('span', '', say(r.own.label)));
      return own;
    }

    // A line of the person's own on the face: saved on leaving the field or on Enter.
    function drawText(r) {
      const li = ctx.rowShell(r, 'xm-row--stack');
      const field = el('input', 'xm-search xm-pumptext');
      field.type = 'text';
      field.maxLength = r.max;
      field.value = r.value;
      field.placeholder = say(r.hint);
      field.setAttribute('aria-label', say(r.label));
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); field.blur(); } });
      field.addEventListener('change', () => {
        const act = field.value.trim() === r.value ? null : withMark(r.act, r.mark, field.value.trim());
        if (act) perform(r, act);
      });
      li.appendChild(field);
      return li;
    }

    const LOOK = {
      pumpcap: (r) => el('span', 'xm-pumpline-cap', say(r.label)),
      pumpkeys: drawKeys,
      pumptext: drawText,
      pumpupload: (r) => (typeof ctx.upload === 'function' ? picker(r.id, r) : null),
    };

    return { draw: { pumpmoment: drawMoment, pumpnote: drawNote, pumpcards: drawCards, pumpadd: drawAdd } };
  }

  const api = { create, withFile, withMark, FILE_MARK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.XenonMenuPumpRows = api;
})();
