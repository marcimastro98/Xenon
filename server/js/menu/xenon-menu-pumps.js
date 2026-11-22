'use strict';

// The pump screens on the Screens page of the Xenon menu (rows from server/menu/menu-pump.js):
// under the desk, one card per pump drawn in its shape, saying what it shows now; and for
// the one tapped, the pump's own page (/pump-face?preview=1) in its shape above its tabs, so
// a change shows as the pump shows it. The menu rebuilds its rows after every change and a
// frame put back into the page loads again, so the one frame waits in a hidden holder during
// a rebuild (`hold`, then `settle`), as the scene preview does (xenon-menu-scene-view.js).
// The page is the PC's own: a paired phone is refused it (paired/refused-paths.js), so on
// a phone the cards come without the picture. Beside it, what the pump shows now and why, and
// a way back to automatic after a face was chosen by hand. `upload` sends a picture or GIF of
// the person's own (POST /pump/picture, pump-screen/picture.js) for a line of the pump's tabs
// (xenon-menu-pump-rows.js) and for Bit's file choice.
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

  // ctx: { el, button, say, icon, server, doc, move, host, perform }
  //   host: the page's host name; the picture only where it is this PC's own page
  function create(ctx) {
    const { el, button, say, icon } = ctx;
    const put = ctx.move || ((parent, node) => parent.insertBefore(node, null));
    const shows = typeof ctx.server === 'string' && LOOPBACK.includes(ctx.host);
    let frame = null;
    let holder = null;
    let box = null;
    let want = '';
    let trying = null;     // { show, label }: the line open in the pump's tabs, shown in the picture
    let nowBox = null;
    let triedWhat = null;  // in it, the name of the line the picture shows
    let painting = false;

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

    // What the pump shows now and why ("Now on the pump: Song, because you are listening to
    // music"); after a face chosen by hand, the way back to automatic.
    function nowBlock(view) {
      const n = view.now;
      if (!n) return null;
      const box = el('div', 'xm-pumpnow');
      const live = el('span', 'xm-pumpnow-live');
      live.append(el('span', 'xm-pumpnow-cap', say(n.caption)), el('span', 'xm-pumpnow-what', say(n.what)));
      if (n.why) live.appendChild(el('span', 'xm-pumpnow-why', say(n.why)));
      // While a line is open the picture shows that line; the words say so, and what the pump has.
      const tried = el('span', 'xm-pumpnow-tried');
      triedWhat = el('span', 'xm-pumpnow-what');
      tried.append(el('span', 'xm-pumpnow-cap', say({ key: 'xmenu_pump_try_cap' })), triedWhat,
        el('span', 'xm-pumpnow-why', say({ key: 'xmenu_pump_try_now', vars: { what: say(n.what) } })));
      box.append(live, tried);
      nowBox = box;
      if (n.back && typeof ctx.perform === 'function') {
        const b = button('ui-btn ui-btn--secondary xm-act', say(n.back.label));
        b.dataset.keep = 'pump:auto';
        b.addEventListener('click', () => ctx.perform(null, n.back.act));
        box.appendChild(b);
      }
      return box;
    }

    // Above the tabs of the pump picked: its picture (on this PC's own page) and what it shows
    // now; null for a pump not set up yet.
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
      const now = nowBlock(view);
      if (now) head.appendChild(now);
      return box || now ? head : null;
    }

    // The picture shows the line open below it until it closes (pump-face.js tryFace). Asked while
    // the menu rebuilds, it waits for settle(): the open line is drawn again in the rebuild.
    function apply() {
      try { frame?.contentWindow?.PumpFace?.tryFace(trying ? trying.show : null); } catch { /* another origin: its own face stays */ }
      if (!nowBox?.isConnected) return;
      nowBox.classList.toggle('is-trying', !!trying);
      triedWhat.textContent = trying ? say(trying.label) : '';
    }

    function tryFace(show, label) {
      trying = show ? { show, label } : null;
      if (!painting) apply();
    }

    function hold() {
      painting = true;
      trying = null;
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
      painting = false;
      if (!box?.isConnected) { drop(); apply(); return; }
      if (!frame) {
        frame = el('iframe', 'xm-pumpframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.addEventListener('load', () => { frame?.classList.add('is-ready'); apply(); });
      }
      put(box, frame);
      if (frame.dataset.src !== want) {
        frame.dataset.src = want;
        frame.classList.remove('is-ready');
        frame.src = want;
      }
      apply();
    }

    return { cards, slot, hold, settle, tryFace };
  }

  const api = { create, previewUrl, upload, drawSize, shapeProps, PICTURE_TYPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.XenonMenuPumps = api;
})();
