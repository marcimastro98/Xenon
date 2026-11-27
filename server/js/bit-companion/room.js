'use strict';
// The room of the person's own Bit, all in bit-companion/: a stage (room-scenery.js) with the Bit big in the
// middle, its items on a rail (wardrobe.js) and under the Bit one step: keep what it tries on (wardrobe-keep.js),
// else make its card or video; the egg has one button. Sharing and settings open in a drawer (room-panels.js).
// It fills the Bit's sheet (sheet.js) and the Store's "Your Bit" view; the server keeps it all (server/bit/)
// and every answer goes through BitApp.heard, so every place on the page follows.
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GEAR = ['....#....', '.#.###.#.', '..#####..', '.##...##.', '###...###', '.##...##.', '..#####..', '.#.###.#.', '....#....'];
  const CROSS = ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'];
  const live = new Set(); // the rooms on screen, for Esc

  const say = (key, vars = {}) => String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const num = (n) => Number(n).toLocaleString(typeof lang === 'string' ? lang : 'en');
  const bitNow = () => window.BitApp?.state() || null;
  const told = (out) => { if (out?.ok && out.bit && window.BitApp) window.BitApp.heard(out.bit); };
  let rooms = 0;

  async function post(path, body) {
    try {
      const res = await fetch(`${typeof SERVER === 'string' ? SERVER : ''}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      return (await res.json().catch(() => null)) || { ok: false, error: 'offline' };
    } catch { return { ok: false, error: 'offline' }; }
  }

  function pixels(rows) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${rows[0].length} ${rows.length}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    rows.forEach((row, y) => { [...row].forEach((c, x) => {
      if (c !== '#') return;
      const r = document.createElementNS(SVG_NS, 'rect');
      for (const [k, v] of [['x', x], ['y', y], ['width', 1], ['height', 1], ['fill', 'currentColor']]) r.setAttribute(k, String(v));
      svg.append(r);
    }); });
    return svg;
  }

  function button(cls, text, onClick, signal) {
    const b = Object.assign(makeEl('button', cls, text), { type: 'button' });
    b.addEventListener('click', onClick, { signal });
    return b;
  }

  function iconButton(rows, label, onClick, signal) {
    const b = button('broom-icon', '', onClick, signal);
    b.setAttribute('aria-label', label);
    b.append(pixels(rows));
    return b;
  }

  /**
   * Builds a room in `host`.
   * @param {HTMLElement} host
   * @param {{ mode?: 'sheet'|'store', close?: () => void }} [opts] the sheet passes its close; the Store has its own
   * @returns {{ root: HTMLElement, titleId: string, fill: (bit: object) => void, escape: () => boolean, destroy: () => void }}
   */
  function mount(host, opts = {}) {
    const store = opts.mode === 'store';
    const stop = new AbortController();
    const { signal } = stop;
    const room = { on: false, kind: null, player: null, hatching: false, revealing: false, timer: 0, panel: null, colours: '', opener: null };
    const root = makeEl('div', store ? 'broom is-store' : 'broom');
    const inner = makeEl('div', 'broom-in');
    const stage = makeEl('div', 'broom-stage');
    const theatre = makeEl('div', 'broom-theatre');
    const scenery = makeEl('div', 'broom-scenery');
    const spot = makeEl('div', 'broom-spot');
    const top = makeEl('div', 'broom-top');
    const noteEl = makeEl('p', 'broom-note');
    noteEl.setAttribute('role', 'status');
    const dock = makeEl('div', 'broom-dock');
    theatre.append(scenery, spot, top, noteEl);
    stage.append(theatre, dock);
    const side = makeEl('div', 'broom-side');
    const drawer = makeEl('section', 'broom-drawer');
    drawer.hidden = true;
    inner.append(stage, side, drawer);
    root.append(inner);
    const titleId = `broom-title-${++rooms}`;

    const hands = {
      say, num, post, told, signal,
      note: (text) => { noteEl.textContent = text || ''; },
      play: (id) => { if (room.player && window.Xenon?.bit?.clip(id)) room.player.play(id); },
      redraw: () => fill(bitNow()),
      refresh: () => room.player?.refresh(), changed: () => dockFill(bitNow(), true), close: () => closePanel(),
      takeOff: () => window.BitWardrobe?.takeOff(null, bitNow(), hands),
      balance: () => balance,
    };
    const balance = balanceButton();

    // Its Sparks beside the rail: a tap opens the Store's Sparks.
    function balanceButton() {
      const C = window.XenonCredits;
      if (!C?.onChange) return null;
      const b = button('broom-balance', '', () => { if (!store) window.BitSheet?.close(); C.openShop(); }, signal);
      const paint = () => {
        if (room.on && !root.isConnected) { destroy(); return; }
        const s = C.state;
        b.hidden = s?.status !== 'ok' || !Number.isFinite(s.balance);
        if (b.hidden) return;
        b.replaceChildren(...[typeof C.spark === 'function' ? C.spark({ still: true }) : null, num(s.balance)].filter(Boolean));
        b.setAttribute('aria-label', say('mybit_balance', { n: num(s.balance) }));
      };
      paint();
      signal.addEventListener('abort', C.onChange(paint));
      C.refresh?.(false);
      return b;
    }

    // The theatre in its colours, drawn again only when they change (it hatched, or another Bit).
    function paintStage(bit) {
      const key = JSON.stringify([!!bit.hatched, bit.genes?.palette]);
      if (room.colours === key || !window.BitScenery) return;
      room.colours = key;
      const { pieces, colours } = window.BitScenery.draw(bit);
      scenery.replaceChildren(...pieces);
      for (const name of ['wall', 'text', 'muted', 'brass', 'floor', 'seam']) root.style.setProperty(`--broom-${name}`, colours[name]);
    }

    // The big Bit on its stand: the egg, or the person's Bit wearing what it tries on.
    function standBit(bit) {
      const kind = bit.hatched ? 'bit' : 'egg';
      if (room.kind === kind) return;
      room.kind = kind;
      const bitBtn = button('broom-bit', '', () => {
        if (!bitNow()?.hatched) { hatch(); return; }
        room.player?.poke();
      }, signal);
      bitBtn.setAttribute('aria-label', say(bit.hatched ? 'mybit_poke' : 'mybit_hatch'));
      spot.replaceChildren(bitBtn);
      const hold = window.BitApp ? window.BitApp.TILE_HOLD.filter((name) => name !== 'overlay-frozen') : [];
      room.player = window.BitApp?.mount(bitBtn, {
        mood: bit.hatched ? 'idle' : 'egg', fidgets: bit.hatched, look: () => window.BitWardrobe?.preview() || window.BitApp.personal(), hold, home: true,
      }) || null;
    }

    function head(bit) {
      const who = button('broom-who', '', () => openPanel('about'), signal);
      const title = makeEl('h2', 'broom-name', bit.hatched ? bit.name || say('mybit_title') : say('mybit_egg_label'));
      title.id = titleId;
      who.append(title);
      if (bit.hatched) {
        who.append(makeEl('p', 'broom-id', bit.number ? say('mybit_number', { n: num(bit.number) }) : say('mybit_local')));
        const rare = window.BitCard?.rareLine(bit, say, num);
        if (rare) who.append(makeEl('p', 'broom-rare', rare));
      }
      const tools = makeEl('div', 'broom-tools');
      tools.append(iconButton(GEAR, say(bit.hatched ? 'mybit_about' : 'mybit_place'), () => openPanel('about'), signal));
      if (!store && opts.close) tools.append(iconButton(CROSS, say('close'), opts.close, signal));
      top.replaceChildren(who, tools);
    }

    // Under the Bit, one step: keep what it tries on, else its card or video; the egg hatches. News of the
    // Bit that changes none of it leaves the step alone, so an open buy stays open.
    function dockFill(bit, force) {
      const key = bit && !room.revealing ? JSON.stringify([bit.hatched, bit.founder, bit.owned, window.BitWardrobe?.tried()]) : null;
      if (!force && key && key === room.dockKey) return;
      room.dockKey = key;
      if (!key) { dock.replaceChildren(); return; }
      if (!bit.hatched) {
        const go = button('broom-btn is-main', say('mybit_hatch'), () => hatch(), signal);
        go.dataset.hatch = '';
        dock.replaceChildren(makeEl('p', 'broom-line', say(bit.founder ? 'mybit_card_text' : 'mybit_egg_line')), go);
        return;
      }
      const tried = window.BitWardrobe?.tried() || [];
      if (tried.length && window.BitKeep) { dock.replaceChildren(window.BitKeep.bar(bit, tried, hands)); return; }
      const video = window.BitClip?.recorderType?.() ? button('broom-btn is-main', say('mybit_clip_make'), () => make('clip'), signal) : null;
      const card = button(video ? 'broom-btn' : 'broom-btn is-main', say('mybit_share'), () => make('card'), signal);
      const acts = makeEl('div', 'broom-acts');
      acts.append(...[card, video].filter(Boolean));
      dock.replaceChildren(makeEl('p', 'broom-line', say('mybit_try_hint')), acts);
    }

    // Opens the sharing drawer on the card, which draws itself, or on the video, started as if its own button was pressed.
    function make(part) {
      window.BitPanels?.choose(part);
      openPanel('share');
      if (part === 'clip') drawer.querySelector('.bitc-clip .bitc-card-slot > button.bitc-seg-btn:not(:disabled)')?.click();
    }

    function openPanel(kind) {
      const bit = bitNow();
      const built = bit && window.BitPanels?.build(kind, bit, hands);
      if (!built) return;
      if (!room.panel) room.opener = document.activeElement;
      const kept = room.panel === kind ? drawer.querySelector('.broom-panel-body')?.scrollTop || 0 : 0; // redrawn after a choice
      const bar = makeEl('div', 'broom-drawer-head');
      bar.append(makeEl('h3', 'broom-drawer-title', built.title), iconButton(CROSS, say('close'), closePanel, signal));
      drawer.replaceChildren(bar, built.body);
      if (kept) (drawer.querySelector('.broom-panel-body') || {}).scrollTop = kept; // ...keeps its place, never the top
      room.panel = kind;
      drawer.setAttribute('aria-label', built.title);
      if (drawer.hidden) {
        drawer.hidden = false;
        root.classList.add('has-drawer');
        bar.querySelector('button').focus({ preventScroll: true });
      }
    }

    function closePanel() {
      if (!room.panel) return false;
      room.panel = null;
      drawer.hidden = true;
      drawer.replaceChildren();
      root.classList.remove('has-drawer');
      if (room.opener?.isConnected) room.opener.focus({ preventScroll: true });
      return true;
    }

    // The rail drawn again keeps the item that had the focus.
    function railFill(bit) {
      const had = root.contains(document.activeElement) ? document.activeElement.closest('.broom-card')?.dataset.item : null;
      const rail = bit.hatched ? window.BitWardrobe?.rail(bit, hands) : null;
      side.replaceChildren(...(rail ? [rail] : []));
      if (had) side.querySelector(`.broom-card[data-item="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
    }

    function fill(bit) {
      if (!bit || room.revealing || room.hatching || signal.aborted) return; // a hatch heard early waits for its reveal
      root.classList.toggle('is-egg', !bit.hatched);
      paintStage(bit);
      standBit(bit);
      head(bit);
      railFill(bit);
      dockFill(bit);
      const panel = room.panel || window.BitSetup?.first(bit, room); // the guided setup opens by itself once
      if (panel) openPanel(panel);
    }

    async function hatch() {
      if (room.hatching) return;
      room.hatching = true;
      const go = dock.querySelector('[data-hatch]');
      if (go) go.disabled = true;
      const out = await post('/api/bit/hatch', {});
      if (signal.aborted) return;
      room.hatching = false;
      if (!out.ok) {
        if (go) go.disabled = false;
        hands.note(say(out.error === 'waiting' ? 'mybit_hatch_wait' : 'mybit_hatch_failed'));
        return;
      }
      // The egg breaks first; then the room takes its colours and its items come out.
      room.revealing = true;
      told(out);
      closePanel();
      dock.replaceChildren();
      room.kind = null;
      standBit(out.bit);
      const clip = window.Xenon?.bit?.clip('hatch');
      if (room.player && clip) room.player.play('hatch');
      const ms = clip ? clip.frames.reduce((sum, f) => sum + f.ms, 0) : 0;
      room.timer = setTimeout(() => { room.revealing = false; fill(bitNow() || out.bit); }, ms);
    }

    function destroy() {
      if (signal.aborted) return;
      live.delete(api);
      clearTimeout(room.timer);
      stop.abort();
      root.remove();
      for (const part of [window.BitWardrobe, window.BitCard, window.BitRecap, window.BitClip]) part?.reset();
      window.BitApp?.sweep();
    }

    // A view the Store took away stops at the next news, like the Store's other views.
    addEventListener('xenon-bit', (e) => { if (!root.isConnected) destroy(); else if (e.detail) fill(e.detail); }, { signal });
    const api = { root, titleId, fill, escape: closePanel, destroy };
    live.add(api);
    host.append(root);
    room.on = true;
    fill(bitNow());
    return api;
  }

  /**
   * The Store's "Your Bit" view: the same room, filling the view.
   * @param {HTMLElement} viewEl the Store's view
   */
  function storeView(viewEl) {
    for (const r of [...live]) if (r.root.classList.contains('is-store')) r.destroy();
    viewEl.replaceChildren();
    const bit = bitNow();
    if (bit?.ok !== true) {
      viewEl.append(makeEl('div', 'cgal-status', say('mybit_unavailable')));
      return null;
    }
    return mount(viewEl, { mode: 'store' });
  }

  window.BitRoom = {
    mount, store: storeView,
    /** Esc closes an open drawer first; true when it did. */
    escape: () => [...live].some((r) => r.escape()),
  };
})();
