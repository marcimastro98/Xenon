'use strict';

// ── Notification island (minimal chrome) ──────────────────────────────────────
// In minimal chrome a notification takes the clock pill's place, and it is ONE
// surface changing shape: the pill's glass grows into the card, turns into the
// next card or the list, and shrinks back into the pill. It floats OVER the
// tiles: their cut around the pill closes while it is open and reopens when the
// pill is back (topbar-minimal.js); their content never moves.
//   - One notification at a time, the newest. The others wait with their timers
//     stopped, counted by a "+N" chip that opens them as a list.
//   - The surface (.xisland-bg) is a layout box animated on left/top/width/
//     height/border-radius, never a scale, so the text inside is never stretched.
//   - Two skins cross-fade on it: the pill's glass and the card's accent glass.
// toast.js owns the records, timers and gestures; this file only places them.
(function () {
  const BOX_MS = { open: 480, swap: 380, close: 420, resize: 260 };
  const CONTENT_OUT_MS = 120;
  const CONTENT_IN_MS = 200;
  // Content enters this far into the box's travel: while the glass is still
  // growing, so the card never shows up empty and fills in afterwards.
  const CONTENT_IN_AT = 0.18;
  const CONTENT_RISE = 4;     // px the content rises while it fades in
  const YIELD_MS = 140;       // the pill's contents fade before the glass takes over
  const SKIN_MS = 300;
  const SKIN_HOLD = 0.5;      // the outgoing skin waits this share of SKIN_MS
  const ICON_POP = 0.8;       // the app tile springs in from this scale
  const ICON_POP_MS = 420;
  const FLING_MS = 260;
  // The pill's face fades in on the glass once it is nearly the pill's width (a
  // card is narrower than the pill, so earlier it would spill past the glass).
  const GHOST_IN_AT = 0.3;
  const GHOST_IN_MS = 170;
  // With no pill on screen to land on, the glass settles out where it is instead.
  const VANISH_MS = 360;
  const VANISH_SHRINK = { width: 0.86, height: 0.6, rise: 6 };
  const HOME_Z = 57;          // .topbar-mini z-index (TopbarMinimal.css)
  const CARD_RADIUS = 22;     // .xtoast border-radius (Toast.css)
  const LIST_ROWS = 4;
  const LIST_IDLE_MS = 8000;
  const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const SPRING = springEasing();

  // A spring with a ~1.5% overshoot as a CSS linear() curve (damping ratio 0.8,
  // sampled until it has settled). Engines without linear() get the ease-out.
  function springEasing() {
    try {
      if (!(window.CSS && CSS.supports('transition-timing-function', 'linear(0, 1)'))) return EASE_OUT;
    } catch { return EASE_OUT; }
    const zeta = 0.8, w = 8.6, wd = w * Math.sqrt(1 - zeta * zeta);
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const x = 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t));
      pts.push(Number(x.toFixed(4)));
    }
    pts[pts.length - 1] = 1;
    return 'linear(' + pts.join(', ') + ')';
  }

  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const px = (b) => ({ left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px', borderRadius: b.radius + 'px' });
  const near = (a, b) => !!a && !!b && ['left', 'top', 'width', 'height', 'radius'].every(k => Math.abs(a[k] - b[k]) < 0.5);

  // Fade `el` from wherever it is now to `to`, optionally rising into place.
  // The end state is written inline, so a cancelled fade still lands right.
  function fade(el, to, ms, delay, rise) {
    const from = getComputedStyle(el).opacity;
    el.getAnimations().forEach(a => { if (a.id === 'xisland-fade') a.cancel(); });
    el.style.opacity = String(to);
    if (reduced() || typeof el.animate !== 'function' || String(from) === String(to)) return Promise.resolve();
    const frames = rise
      ? [{ opacity: from, translate: '0 ' + rise + 'px' }, { opacity: to, translate: '0 0' }]
      : [{ opacity: from }, { opacity: to }];
    const a = el.animate(frames, { duration: ms, delay: delay || 0, easing: 'ease', fill: 'backwards' });
    a.id = 'xisland-fade';
    return a.finished.then(() => {}, () => {});
  }

  // The card's app tile springs into place as its text arrives (the stack does
  // the same in CSS, see .xtoast-in > .xtoast-icon).
  function popIcon(card, delay) {
    const icon = card.querySelector(':scope > .xtoast-icon');
    if (!icon || reduced() || typeof icon.animate !== 'function') return;
    icon.animate([{ scale: ICON_POP }, { scale: 1 }], { duration: ICON_POP_MS, delay, easing: SPRING, fill: 'backwards' });
  }

  function create(host) {
    let root = null, bg = null, slot = null, pillSkin = null, ghost = null;
    let order = [];      // ids on the island, newest first
    let shownId = 0;
    let view = 'card';   // 'card' | 'list' (with nothing to show: the pill)
    let held = false;    // the glass has the pill's place (body.xtoast-island)
    let homing = false;  // ...and is on its way back: the tiles reopen their cut
    let flinging = false;
    let target = null;   // the box the glass is heading to
    let gen = 0;         // a newer render makes an older one stop where it is
    let listTimer = 0;

    const pillEl = () => document.getElementById('topbar-mini');

    function build() {
      if (root) return;
      root = document.createElement('div');
      root.className = 'xisland';
      root.hidden = true;
      bg = document.createElement('div');
      bg.className = 'xisland-bg';
      pillSkin = document.createElement('div');
      pillSkin.className = 'xisland-skin xisland-skin--pill';
      bg.appendChild(pillSkin);
      slot = document.createElement('div');
      slot.className = 'xisland-slot';
      root.append(bg, slot);
      document.body.appendChild(root);
      // A chip appearing or a line wrapping changes the content's size: follow it.
      if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(slot);
    }

    function readBox() {
      const cs = getComputedStyle(bg);
      return {
        left: parseFloat(cs.left) || 0, top: parseFloat(cs.top) || 0,
        width: parseFloat(cs.width) || 0, height: parseFloat(cs.height) || 0,
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
      };
    }

    // Glide the glass to `to` from wherever it is, mid-flight included. Layout
    // properties on one fixed element with nothing in flow inside it: cheap.
    function morphBox(to, ms, easing) {
      const from = readBox();
      bg.getAnimations().forEach(a => a.cancel());
      slot.getAnimations().forEach(a => { if (a.id === 'xisland-clip') a.cancel(); });
      Object.assign(bg.style, px(to));
      target = to;
      if (reduced() || typeof bg.animate !== 'function' || near(from, to)) return Promise.resolve();
      const timing = { duration: ms, easing: easing || SPRING };
      // The content is cut to the glass on the way, so text never shows past
      // its edges while the glass is still smaller than the card (opening, a
      // bigger card next, closing onto the pill).
      if (slot.firstElementChild) {
        const box = contentBox();
        slot.animate([{ clipPath: clipTo(from, box) }, { clipPath: clipTo(to, box) }], timing).id = 'xisland-clip';
      }
      return bg.animate([px(from), px(to)], timing).finished.then(() => {}, () => {});
    }

    // The glass box `g` as a clip on the slot's box `s`: an inset, never past the
    // slot (the spring's overshoot makes the glass the larger of the two).
    function clipTo(g, s) {
      const inset = [g.top - s.top, (s.left + s.width) - (g.left + g.width), (s.top + s.height) - (g.top + g.height), g.left - s.left]
        .map(v => Math.max(0, v) + 'px');
      return 'inset(' + inset.join(' ') + ' round ' + g.radius + 'px)';
    }

    // Where the island lives without a notification: the pill, or the SDK capsule
    // that has taken it. Without either (no size yet), a small capsule where the
    // card will sit.
    function homeBox() {
      const h = window.TopbarMinimal && typeof window.TopbarMinimal.homeBox === 'function' ? window.TopbarMinimal.homeBox() : null;
      if (h && h.height > 0 && h.right > h.left) {
        return { left: h.left, top: h.top, width: h.right - h.left, height: h.height, radius: h.radius, pill: h.kind === 'pill' };
      }
      const w = 120, ht = 36;
      return { left: slot.offsetLeft + (slot.offsetWidth - w) / 2, top: slot.offsetTop, width: w, height: ht, radius: ht / 2, pill: false, none: true };
    }

    // Worth flying back to only if it will be on screen when the glass lands. The
    // pill sits below every overlay, so under Settings (or with no pill at all)
    // the glass would shrink into an empty capsule floating over the overlay,
    // and then blink out. Anything positioned above the pill's band on its spot
    // means it is covered (the pill itself is visibility:hidden here, so the hit
    // test sees what is behind or above it, never the pill).
    function homeOnScreen(home) {
      if (!home || home.none || typeof document.elementsFromPoint !== 'function') return false;
      const hits = document.elementsFromPoint(home.left + home.width / 2, home.top + home.height / 2);
      const hit = hits.find(el => !root.contains(el));
      for (let el = hit; el && el !== document.body; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'static' && (parseInt(cs.zIndex, 10) || 0) > HOME_Z) return false;
      }
      return true;
    }

    // Layout values, not a rect: the island may be mid-swipe (a transform).
    const contentBox = () => ({ left: slot.offsetLeft, top: slot.offsetTop, width: slot.offsetWidth, height: slot.offsetHeight, radius: CARD_RADIUS });
    const currentContent = () => (slot ? slot.firstElementChild : null);

    // ── Skins ──────────────────────────────────────────────────────────────────
    // The card's glass is the same for every notification (its colour lives in
    // the app tile), so there is one card skin, made on first use.
    function cardSkin() {
      const have = Array.from(bg.children).find(s => s !== pillSkin);
      if (have) return have;
      const s = document.createElement('div');
      s.className = 'xisland-skin xisland-skin--card';
      s.style.opacity = '0';
      bg.appendChild(s);
      return s;
    }

    // Two translucent layers fading against each other thin out halfway (the
    // tiles show through the glass). So the incoming skin goes on top and fades
    // in, and the ones under it only start to go once it covers them.
    function wear(skin) {
      if (bg.lastElementChild !== skin) bg.appendChild(skin);
      fade(skin, 1, SKIN_MS);
      Array.from(bg.children).forEach((s) => {
        if (s === skin) return;
        fade(s, 0, SKIN_MS * (1 - SKIN_HOLD), SKIN_MS * SKIN_HOLD).then(() => {
          if (s !== pillSkin && s.isConnected && s.style.opacity === '0') s.remove();
        });
      });
    }


    // ── Content ────────────────────────────────────────────────────────────────
    function wanted() {
      if (!order.length) return null;
      if (view === 'list' && order.length > 1) return 'list';
      if (!order.includes(shownId)) shownId = order[0];
      return 'card';
    }

    // Only the card on show runs its countdown; the waiting ones keep what they had.
    function syncTimers(kind) {
      order.forEach(id => (kind === 'card' && id === shownId ? host.arm(id) : host.pause(id)));
    }

    function prepareCard(id) {
      const rec = host.toasts.get(id);
      const el = rec.el;
      // A card coming back resumes its bar where its timer is (re-inserting it
      // restarts the CSS animation from the top otherwise).
      const prog = el.querySelector(':scope > .xtoast-close .xtoast-progress');
      if (prog && rec.dur > 0) {
        const left = rec.startedAt ? rec.remaining - (Date.now() - rec.startedAt) : rec.remaining;
        prog.style.animationDelay = Math.min(0, left - rec.dur) + 'ms';
      }
      el.classList.remove('xtoast-in');
    }

    function refreshMore() {
      const card = currentContent();
      if (!card || !card.classList.contains('xtoast')) return;
      const n = order.length - 1;
      let chip = card.querySelector(':scope > .xisland-more');
      card.classList.toggle('has-more', n > 0);
      if (n <= 0) { if (chip) chip.remove(); return; }
      if (!chip) {
        chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'xisland-more';
        chip.addEventListener('click', (e) => { e.stopPropagation(); view = 'list'; render(); });
        card.appendChild(chip);
      }
      chip.textContent = '+' + n;
      chip.setAttribute('aria-label', host.t('toast_more', '{n} more notifications').replace('{n}', String(n)));
    }

    function detach(el) {
      el.getAnimations().forEach(a => { if (a.id === 'xisland-fade') a.cancel(); });
      el.style.removeProperty('opacity');
      const chip = el.querySelector(':scope > .xisland-more');
      if (chip) chip.remove();
      el.classList.remove('has-more');
      el.remove();
    }

    function listRow(id) {
      const rec = host.toasts.get(id);
      const row = document.createElement('div');
      row.className = 'xisland-row';
      ['--xt-rgb', '--xt-ink'].forEach(p => row.style.setProperty(p, rec.el.style.getPropertyValue(p)));
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'xisland-row-open';
      const icon = rec.el.querySelector(':scope > .xtoast-icon');
      if (icon) open.appendChild(icon.cloneNode(true));
      const text = document.createElement('span');
      text.className = 'xisland-row-text';
      if (rec.info.kicker) {
        const k = document.createElement('span');
        k.className = 'xtoast-kicker';
        k.textContent = rec.info.kicker;
        text.appendChild(k);
      }
      const title = document.createElement('span');
      title.className = 'xtoast-title';
      title.textContent = rec.info.title;
      text.appendChild(title);
      open.appendChild(text);
      // A row opens its notification as the card, where its actions are.
      open.addEventListener('click', () => { shownId = id; view = 'card'; render(); });
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'xtoast-close xisland-row-close';
      close.setAttribute('aria-label', host.t('close', 'Close'));
      const x = rec.el.querySelector(':scope > .xtoast-close > .xtoast-x');
      if (x) close.appendChild(x.cloneNode(true));
      close.addEventListener('click', () => host.dismiss(id));
      row.append(open, close);
      return row;
    }

    function fillList(list) {
      list.replaceChildren(...order.slice(0, LIST_ROWS).map(listRow));
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'xtoast-action xisland-list-clear';
      all.textContent = host.t('toast_dismiss_all', 'Clear all');
      all.addEventListener('click', () => host.dismissAll());
      list.appendChild(all);
    }

    function buildList() {
      const list = document.createElement('div');
      list.className = 'xisland-list';
      list.addEventListener('pointerdown', armListIdle);
      fillList(list);
      return list;
    }

    // ── The list closes on its own: idle, Escape or a tap anywhere else ────────
    function closeList() { if (view === 'list') { view = 'card'; render(); } }
    function onOutside(e) { if (root && !root.contains(e.target)) closeList(); }
    function onKey(e) { if (e.key === 'Escape') closeList(); }
    function armListIdle() {
      clearTimeout(listTimer);
      listTimer = setTimeout(closeList, LIST_IDLE_MS);
    }
    function listListeners(on) {
      const m = on ? 'addEventListener' : 'removeEventListener';
      document[m]('pointerdown', onOutside, true);
      document[m]('keydown', onKey);
      if (on) armListIdle(); else clearTimeout(listTimer);
    }

    // ── Transitions ────────────────────────────────────────────────────────────
    // Glass appears at the home box in the frame the pill steps aside.
    async function open(g) {
      build();
      const home = homeBox();
      bg.getAnimations().forEach(a => a.cancel());
      Object.assign(bg.style, px(home));
      target = home;
      pillSkin.style.opacity = '1';
      const pill = home.pill ? pillEl() : null;
      if (pill && !reduced()) {
        pill.classList.add('mini-yield');
        await wait(YIELD_MS);
        if (g !== gen) return false;
      }
      root.hidden = false;
      held = true;
      host.sync();
      return true;
    }

    function release(fromFling) {
      listListeners(false);
      if (root) root.remove();
      root = bg = slot = pillSkin = ghost = target = null;
      held = homing = flinging = false;
      host.sync();
      const pill = pillEl();
      if (!pill) return;
      pill.classList.remove('mini-yield'); // its contents fade back in
      // After a fling there is no glass to hand over to: the pill fades back.
      if (fromFling && !reduced() && typeof pill.animate === 'function') {
        pill.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease' });
      }
    }

    // The pill's face rides the glass home: a copy of its contents fades in over
    // the last stretch of the trip, so the glass lands as the pill, never as an
    // empty capsule. The real pill (still visibility:hidden) takes over in the
    // frame the glass lands, its contents already back from .mini-yield.
    function carryHome(home) {
      const pill = home.pill ? pillEl() : null;
      if (!pill || reduced()) return;
      pill.classList.remove('mini-yield');
      ghost = pill.cloneNode(true);
      ghost.removeAttribute('id');
      ghost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      ghost.classList.remove('mini-yield', 'mini-morph-dim', 'mini-morphing');
      ghost.classList.add('xisland-ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      ghost.style.opacity = '0';
      root.insertBefore(ghost, slot);
      fade(ghost, 1, GHOST_IN_MS, BOX_MS.close * GHOST_IN_AT);
    }

    function dropGhost() {
      if (!ghost) return;
      const el = ghost;
      ghost = null;
      fade(el, 0, CONTENT_OUT_MS).then(() => el.remove());
    }

    // No pill on screen to land on: the glass draws in a little and rises as it
    // fades, settling out where it is.
    function vanish() {
      const b = readBox();
      const width = b.width * VANISH_SHRINK.width;
      const height = b.height * VANISH_SHRINK.height;
      const to = { left: b.left + (b.width - width) / 2, top: b.top - VANISH_SHRINK.rise, width, height, radius: Math.min(b.radius, height / 2) };
      // The skins fade, not their parent: an opacity there would drop the blur.
      Array.from(bg.children).forEach(s => fade(s, 0, VANISH_MS * 0.8, VANISH_MS * 0.2));
      return morphBox(to, VANISH_MS, EASE_OUT);
    }

    // The text leaves as the glass starts to move, not before it: waiting for the
    // fade left an empty card standing still for a beat.
    async function close(g) {
      if (!held) { release(false); return; }
      const cur = currentContent();
      if (cur) fade(cur, 0, CONTENT_OUT_MS).then(() => { if (cur.parentNode === slot) detach(cur); });
      const home = homeBox();
      const landing = homeOnScreen(home);
      homing = true;
      host.sync();
      if (landing) {
        wear(pillSkin);
        carryHome(home);
        await morphBox(home, BOX_MS.close);
      } else {
        await vanish();
      }
      if (g !== gen) return;
      release(false);
    }

    async function render() {
      if (flinging) return; // the fling's end renders what is left
      const g = ++gen;
      const kind = wanted();
      listListeners(kind === 'list');
      if (!kind) { if (root) await close(g); return; }
      if (homing) { homing = false; dropGhost(); host.sync(); } // news caught it on the way home
      syncTimers(kind);
      const opening = !held;
      if (opening && !(await open(g))) return;
      const cur = currentContent();
      let next;
      let entering = false;
      if (kind === 'list' && cur && cur.classList.contains('xisland-list')) {
        fillList(cur);
        next = cur;
      } else {
        next = kind === 'list' ? null : host.toasts.get(shownId).el;
        if (cur && cur !== next) {
          await fade(cur, 0, CONTENT_OUT_MS);
          if (g !== gen) return;
          detach(cur);
        }
        if (!next) next = buildList();
        if (next.parentNode !== slot) {
          entering = kind === 'card';
          if (entering) prepareCard(shownId);
          next.style.opacity = '0';
          slot.appendChild(next);
        }
      }
      refreshMore();
      wear(cardSkin());
      const ms = opening ? BOX_MS.open : BOX_MS.swap;
      const travel = morphBox(contentBox(), ms);
      // Out of the pill the card waits for the glass to start growing; from one
      // card to the next the old one has already faded, so the new one comes in
      // at once (fade through) instead of leaving the glass empty for a beat.
      const at = opening ? ms * CONTENT_IN_AT : 0;
      if (entering) popIcon(next, at);
      await fade(next, 1, CONTENT_IN_MS, at, CONTENT_RISE);
      if (g !== gen) return;
      if (next.classList.contains('xtoast')) next.classList.add('xtoast-in');
      await travel;
    }

    // The content changed size on its own: the glass follows.
    function fit() {
      if (!held || flinging || !currentContent()) return;
      const to = contentBox();
      if (!to.height || near(to, target)) return;
      morphBox(to, BOX_MS.resize);
    }

    function fling(dir) {
      gen++;
      flinging = homing = true;
      listListeners(false);
      host.sync();
      const r = root;
      const end = () => { if (root === r) { release(true); render(); } };
      if (typeof r.animate !== 'function') { end(); return; }
      const from = getComputedStyle(r).transform;
      r.animate([
        { transform: from === 'none' ? 'translateX(0)' : from, opacity: 1 },
        { transform: 'translateX(' + (dir * Math.max(window.innerWidth * 0.6, 420)) + 'px)', opacity: 0 },
      ], { duration: FLING_MS, easing: 'ease-in', fill: 'forwards' }).finished.then(end, end);
    }

    // ── API for toast.js ──────────────────────────────────────────────────────
    function add(id) {
      order = [id].concat(order.filter(x => x !== id));
      shownId = id;
      view = 'card'; // news takes the island, even over an open list
      render();
    }

    // `el` is the record's card (toast.js has already dropped the record).
    function remove(id, dir, el) {
      const wasShown = held && currentContent() === el;
      order = order.filter(x => x !== id);
      if (shownId === id) shownId = order[0] || 0;
      // A list down to one card is that card again, with its countdown running.
      if (order.length < 2) view = 'card';
      if (dir && wasShown && !reduced() && root) { fling(dir); return; }
      // Without the fling nothing else takes back the swipe's offset.
      if (dir && wasShown && root) root.style.transform = '';
      render();
    }

    // The chrome left minimal while cards were on the island: give them all back
    // (oldest first) and take the glass away at once.
    function handBack() {
      gen++;
      const ids = order.slice().reverse();
      order = [];
      shownId = 0;
      view = 'card';
      ids.forEach((id) => { const rec = host.toasts.get(id); if (rec) detach(rec.el); });
      if (root || held) release(false);
      return ids;
    }

    return {
      add,
      remove,
      handBack,
      holding: () => held,
      folded: () => held && !homing,
      owns: (id) => order.includes(id),
      mayRun: (id) => !order.includes(id) || (view === 'card' && id === shownId),
      surface: () => root,
    };
  }

  window.XenonToastIsland = { create };
})();
