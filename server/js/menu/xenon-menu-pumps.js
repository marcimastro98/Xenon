'use strict';

// The pump screens on the Screens page of the Xenon menu (rows from server/menu/menu-pump.js):
// under the desk, one card per pump drawn in its shape, saying what it shows now; and for
// the one tapped, the pump's own page (/pump-face?preview=1) in its shape above its tabs, so
// a change shows as the pump shows it. The menu rebuilds its rows after every change and a
// frame put back into the page loads again, so the one frame waits in a hidden holder during
// a rebuild (`hold`, then `settle`), as the scene preview does (xenon-menu-scene-view.js).
// The page is the PC's own: a paired phone is refused it (paired/refused-paths.js), so on
// a phone the cards come without the picture. Under it, a button puts a picture or GIF of the
// person's own on the pump: POST /pump/picture (pump-screen/picture.js), then the same pumpSet
// action a row runs.
(() => {
  const LOOPBACK = Object.freeze(['127.0.0.1', 'localhost', '[::1]', '::1']);
  // What POST /pump/picture keeps (picture.js): the slideshow's images, and WebM.
  const PICTURE_TYPES = 'image/png,image/jpeg,image/webp,image/gif,video/webm';
  const PICTURE_MAX_BYTES = 20 * 1024 * 1024;
  // Drawn sizes, px: the card's mark and the picture above the tabs (it fits a 390 px phone).
  const CARD_SIDE = 28;
  const CARD_LONG = 42;
  const PREVIEW_SIDE = 176;
  const PREVIEW_LONG = 264;

  // Sends a picture or GIF of the person's own (POST /pump/picture): { ok, url }, or
  // { ok: false, bad } where bad says the pump does not take that file. Bit's file choice in
  // the chat sends it this way too (js/ai/ai-ask-card.js).
  async function upload(server, file, fetchFn = fetch) {
    if (!file || file.size > PICTURE_MAX_BYTES) return { ok: false, bad: true };
    const form = new FormData();
    form.append('asset', file, file.name);
    const r = await fetchFn(`${server}/pump/picture`, { method: 'POST', body: form });
    const d = await r.json().catch(() => null);
    if (d?.ok) return { ok: true, url: d.url };
    return { ok: false, bad: d?.error === 'bad_type' || d?.error === 'too_big' };
  }

  // The size to draw a pump in, from its proportions as mounted (menu-pump.js drawnShape):
  // `base` px on its short side, a landscape panel's long side up to `cap`.
  function drawSize(ratio, base, cap) {
    const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    if (r < 1) return { w: Math.round(base * r), h: base };
    const w = Math.min(base * r, cap);
    return { w: Math.round(w), h: Math.round(w / r) };
  }

  // The CSS properties that draw it: the outline, and for the picture the pump's own page at
  // the panel's size, turned back so its face reads upright (XenonMenuScreens.css).
  function shapeProps(view, base, cap) {
    const { w, h } = drawSize(view.ratio, base, cap);
    const turn = Number(view.turn) || 0;
    const across = turn % 180 !== 0;
    return {
      '--xm-pump-w': w + 'px', '--xm-pump-h': h + 'px',
      '--xm-pump-fw': (across ? h : w) + 'px', '--xm-pump-fh': (across ? w : h) + 'px',
      '--xm-pump-turn': -turn + 'deg',
    };
  }

  function drawShape(node, view, base, cap) {
    for (const [name, value] of Object.entries(shapeProps(view, base, cap))) node.style.setProperty(name, value);
  }

  function previewUrl(server, view) {
    return `${server}/pump-face?${new URLSearchParams({ screen: view.pump, shape: view.shape, preview: '1' })}`;
  }

  // ctx: { el, button, say, icon, server, doc, move, host, perform, fetch }
  //   host: the page's host name; the picture only where it is this PC's own page
  function create(ctx) {
    const { el, button, say, icon } = ctx;
    const put = ctx.move || ((parent, node) => parent.insertBefore(node, null));
    const shows = typeof ctx.server === 'string' && LOOPBACK.includes(ctx.host);
    let frame = null;
    let holder = null;
    let box = null;
    let want = '';

    function card(view, on, pick) {
      const b = button('xm-scrphone xm-scrpump' + (view.add ? ' is-add' : ''));
      b.dataset.keep = 'screen:' + view.key;
      b.setAttribute('aria-pressed', String(on));
      const shape = el('span', 'xm-scrpump-shape' + (view.shape === 'round' ? ' is-round' : ''));
      drawShape(shape, view, CARD_SIDE, CARD_LONG);
      if (view.add) shape.append(icon('plus') || '');
      const words = el('span', 'xm-scrwords');
      words.appendChild(el('span', 'xm-scrname', say(view.label)));
      if (view.chip) words.appendChild(el('span', 'xm-scrchip', say(view.chip)));
      b.append(shape, words);
      b.addEventListener('click', () => {
        pick(view.key);
        // A pump just found: the tap is the step itself (iCUE opens), not a page to find it on.
        // Only on this PC's own page: a paired phone cannot start a program here.
        if (view.act && shows && typeof ctx.perform === 'function') ctx.perform(null, view.act);
      });
      return b;
    }

    function cards(pumps, pickedKey, pick) {
      if (!Array.isArray(pumps) || !pumps.length) return null;
      const list = el('div', 'xm-scrphones xm-scrpumps');
      list.append(...pumps.map((v) => card(v, v.key === pickedKey, pick)));
      return list;
    }

    async function send(view, file, b, note) {
      if (file.size > PICTURE_MAX_BYTES) { note.textContent = say({ key: 'xmenu_pump_own_bad' }); return; }
      b.disabled = true;
      note.textContent = say({ key: 'xmenu_pump_own_busy' });
      try {
        const d = await upload(ctx.server, file, ctx.fetch || fetch);
        if (!d.ok) {
          note.textContent = say({ key: d.bad ? 'xmenu_pump_own_bad' : 'xmenu_pump_own_failed' });
          return;
        }
        note.textContent = '';
        await ctx.perform(null, { run: { type: 'pumpSet', screen: view.pump, patch: JSON.stringify({ base: { face: 'picture', items: [d.url] } }) } });
      } catch {
        note.textContent = say({ key: 'xmenu_pump_own_failed' });
      } finally {
        b.disabled = false;
      }
    }

    // "Use your own picture or GIF": a file input behind a button, its answer said beside it.
    function picker(view) {
      const wrap = el('div', 'xm-pumpown');
      const b = button('ui-btn ui-btn--secondary xm-act', say({ key: 'xmenu_pump_own' }));
      const note = el('span', 'xm-pumpown-note');
      note.setAttribute('role', 'status');
      const input = el('input');
      input.type = 'file';
      input.accept = PICTURE_TYPES;
      input.hidden = true;
      b.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.value = '';
        if (file) send(view, file, b, note);
      });
      wrap.append(b, note, input);
      return wrap;
    }

    // Above the tabs of the pump picked: its picture (on this PC's own page) and the button
    // for a picture of the person's own; null for a pump not set up yet.
    function slot(view) {
      box = null;
      if (!view?.pump) return null;
      const head = el('div', 'xm-pumphead');
      if (shows) {
        want = previewUrl(ctx.server, view);
        box = el('div', 'xm-pumppreview' + (view.shape === 'round' ? ' is-round' : ''));
        drawShape(box, view, PREVIEW_SIDE, PREVIEW_LONG);
        head.appendChild(box);
      }
      if (typeof ctx.perform === 'function') head.appendChild(picker(view));
      return head;
    }

    function hold() {
      if (!frame?.isConnected) return;
      if (!holder) {
        holder = el('div', 'xm-scene-holder');
        holder.hidden = true;
        ctx.doc.body.appendChild(holder);
      }
      put(holder, frame);
    }

    function drop() {
      if (frame) frame.remove();
      if (holder) holder.remove();
      frame = null;
      holder = null;
    }

    // After a rebuild: into the new slot, loading only when the pump picked changed.
    function settle() {
      if (!box?.isConnected) { drop(); return; }
      if (!frame) {
        frame = el('iframe', 'xm-pumpframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.addEventListener('load', () => frame?.classList.add('is-ready'));
      }
      put(box, frame);
      if (frame.dataset.src !== want) {
        frame.dataset.src = want;
        frame.classList.remove('is-ready');
        frame.src = want;
      }
    }

    return { cards, slot, hold, settle };
  }

  const api = { create, previewUrl, upload, drawSize, shapeProps, PICTURE_TYPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.XenonMenuPumps = api;
})();
