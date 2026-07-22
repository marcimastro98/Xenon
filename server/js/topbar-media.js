// Topbar now-playing — cover, title/artist and prev · play/pause · next, shown
// in the topbar while something is actually playing.
//
// It is an island SEGMENT ('media' in topbar-minimal.js ISLAND_SEG_IDS) hosted by
// #clock-media, a sibling of #clock-vitals / #clock-sdkbadges / #clock-claude
// inside .clock. That placement is the whole trick: the minimal topbar reparents
// the entire .clock element into the capsule, so this one piece of markup serves
// BOTH chromes — Full bar and Minimal island — with no mode-specific JS here.
// Being a segment also means it inherits the standard Settings → Dynamic Island
// row (eye toggle to turn it off, drag to reorder it in the capsule) for free;
// there is deliberately no separate setting of its own.
//
// Fed by js/media.js (applyMedia / refreshMediaEmpty) with the same context
// object the media tile renders from, so there is no second polling path and the
// two surfaces can never disagree. Crucially media.js syncs this BEFORE its own
// "is there a media tile?" guard: the topbar controls must keep working for a
// user whose dashboard has no media tile at all.
//
// Untrusted strings (track title, artist, app name) land via textContent only.
(() => {
  'use strict';

  // Static, trusted markup — the same glyphs the media tile's transport uses.
  const ICONS = {
    previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6V6Zm3.5 6 8.5 6V6l-8.5 6Z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2V6ZM6 18l8.5-6L6 6v12Z"/></svg>',
    playpause: '<svg class="tbm-ico-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>'
      + '<svg class="tbm-ico-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/></svg>',
  };

  // Must match the longest transition on .clock-media in TopbarMedia.css — the
  // point at which the segment has finished opening or closing.
  const MORPH_MS = 420;

  const TICK_MS = 1000; // the source data is whole seconds; so is the readout

  let els = null;
  let morphTimer = 0;
  let swapTimer = 0;
  let lastText = '';
  // Progress state: the last sample plus when it arrived, so the ticker
  // interpolates between server pushes instead of stepping only when one lands.
  let posSec = 0;
  let durSec = 0;
  let posAt = 0;
  let playing = false;
  let tickTimer = 0;

  function host() { return document.getElementById('clock-media'); }

  // "Occupa tutta l'isola" (Settings → Dynamic Island → Musica). While a track is
  // actually PLAYING the player takes the whole capsule and topbar-minimal.js
  // masks every other segment off. The moment playback pauses, stops or the
  // player closes this goes false and the bar's normal contents come back — the
  // capsule keeps its own natural size throughout: it hugs the player exactly as
  // it hugs the clock, and never stretches to the width of the screen.
  function takingOver() {
    if (!playing) return false;
    const cfg = (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.topbarClock) || null;
    return !!(cfg && cfg.mediaTakeover === true);
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Appearing/disappearing changes the island pill's structure, so re-run the
  // segment layout (keeps the first-visible segment's "lead" divider correct)
  // and re-tuck any top-row tile now sitting under a pill that changed width.
  // Same contract as js/sdk-badges.js — never called for text-only updates, or a
  // track change would reflow the grid for a few pixels.
  function relayout() {
    const tm = window.TopbarMinimal;
    if (!tm) return;
    if (typeof tm.applyIslandLayout === 'function') tm.applyIslandLayout();
    if (typeof tm.reflowIsland === 'function') tm.reflowIsland();
  }

  // Where the segment is headed, recorded on the element itself so it survives a
  // rebuild of our cached nodes: 'opening' | 'open' | 'closing' | 'closed'.
  //
  // Both morphs MUST be idempotent, and that is not a nicety. sync() runs on every
  // media update, so with nothing playing close() is called over and over; a
  // version that restarted its completion timer on each call never finished the
  // close at all — the segment sat collapsed-but-present forever, invisible and
  // still in the layout. Same shape for open() while a track plays.
  function morphState(h) { return h.dataset.tbmMorph || (h.hidden ? 'closed' : 'open'); }

  function settle(h, state) {
    h.dataset.tbmMorph = state;
    h.classList.remove('tbm-anim', 'tbm-collapsed');
    if (state === 'closed') h.hidden = true;
    relayout();
  }

  // Reveal it collapsed, commit that as the transition's start value, then release
  // it — all in one task. The commit is a single forced reflow (`offsetWidth`) and
  // NOT a requestAnimationFrame pair, which is the obvious way to write this and is
  // wrong here: rAF does not fire in a hidden tab or on a parked pager page, so a
  // track starting while the dashboard is in the background would leave the segment
  // collapsed-but-present forever, and the guard above would then refuse to reopen
  // it. One reflow on a state change (never per update — see sync) is a fair price
  // for a morph that cannot get stuck. Timers settle it either way, so in a hidden
  // tab it simply arrives already open.
  //
  // The pill is re-measured at both ends: once so the island layout knows the
  // segment exists, once when it has reached its real width, or tiles tucked under
  // the capsule get positioned for a pill mid-morph.
  function open(h) {
    const state = morphState(h);
    if (state === 'open' || state === 'opening') return;
    clearTimeout(morphTimer);
    h.dataset.tbmMorph = 'opening';
    h.hidden = false;
    if (reducedMotion()) { settle(h, 'open'); return; }
    h.classList.add('tbm-anim', 'tbm-collapsed');
    relayout();
    void h.offsetWidth; // flush: makes the collapsed state the transition's start
    h.classList.remove('tbm-collapsed');
    morphTimer = setTimeout(() => settle(h, 'open'), MORPH_MS);
  }

  // Close it, then take it out of the layout for good — `hidden` is the settled
  // "nothing is playing" state that applyIslandLayout reads to decide which
  // segment carries the capsule's lead divider.
  function close(h) {
    const state = morphState(h);
    if (state === 'closed' || state === 'closing') return;
    clearTimeout(morphTimer);
    clearTimeout(swapTimer);
    lastText = '';
    h.dataset.tbmMorph = 'closing';
    if (reducedMotion()) { settle(h, 'closed'); return; }
    h.classList.add('tbm-anim', 'tbm-collapsed');
    morphTimer = setTimeout(() => settle(h, 'closed'), MORPH_MS);
  }

  function makeBtn(action, i18nKey, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tbm-btn' + (extraClass ? ' ' + extraClass : '');
    b.setAttribute('data-i18n-title', i18nKey);
    b.title = (typeof t === 'function') ? t(i18nKey) : '';
    b.innerHTML = ICONS[action]; // static, trusted markup
    b.addEventListener('click', (ev) => {
      // The capsule sits over the dashboard and the Full bar's clock has its own
      // handlers — a transport tap is for the player and nothing else.
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof mediaAction === 'function') mediaAction(action);
    });
    return b;
  }

  function build(h) {
    const art = document.createElement('span');
    art.className = 'tbm-art';
    const txt = document.createElement('span');
    txt.className = 'tbm-txt';
    const title = document.createElement('span');
    title.className = 'tbm-title';
    const artist = document.createElement('span');
    artist.className = 'tbm-artist';
    txt.append(title, artist);
    // Elapsed/total row. Built always, shown by CSS only in the Music bar, where
    // there is finally width for it.
    const prog = document.createElement('span');
    prog.className = 'tbm-prog';
    const track = document.createElement('span');
    track.className = 'tbm-prog-track';
    const fill = document.createElement('span');
    fill.className = 'tbm-prog-fill';
    track.append(fill);
    const time = document.createElement('span');
    time.className = 'tbm-prog-time';
    prog.append(track, time);
    // Text and progress stack together so the transport stays a sibling of the
    // pair rather than of each line.
    const main = document.createElement('span');
    main.className = 'tbm-main';
    main.append(txt, prog);
    const ctrls = document.createElement('span');
    ctrls.className = 'tbm-ctrls';
    const play = makeBtn('playpause', 'tip_play', 'tbm-btn-play');
    ctrls.append(makeBtn('previous', 'tip_prev'), play, makeBtn('next', 'tip_next'));
    // Everything lives one level down so the host can collapse to zero width
    // around it (see the grid note in TopbarMedia.css).
    const inner = document.createElement('span');
    inner.className = 'tbm-inner';
    inner.append(art, main, ctrls);
    h.replaceChildren(inner);
    els = { host: h, art, txt, title, artist, prog, fill, time, play };
    return els;
  }

  // ── Progress (Music bar only) ──────────────────────────────────────────────
  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function paintProgress() {
    if (!els) return;
    const over = takingOver();
    els.host.classList.toggle('tbm-takeover', over);
    // The elapsed/total row belongs to the takeover, where the player has the
    // capsule to itself. Live streams and radio publish no timeline (duration 0);
    // there is nothing honest to draw for them, so the row stays away.
    const show = over && durSec > 0;
    els.prog.hidden = !show;
    if (!show) return;
    const drift = playing ? (Date.now() - posAt) / 1000 : 0;
    const at = Math.min(durSec, posSec + drift);
    els.fill.style.transform = 'scaleX(' + (at / durSec).toFixed(4) + ')';
    els.time.textContent = fmtTime(at) + ' / ' + fmtTime(durSec);
  }

  // Gated like every other periodic job here: it runs only while the Music bar
  // is the chrome on screen, something is playing, and there is a duration to
  // count against. Any other state and the timer is not running at all.
  function syncTicker() {
    const want = !!els && takingOver() && durSec > 0;
    if (want && !tickTimer) tickTimer = setInterval(paintProgress, TICK_MS);
    else if (!want && tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
  }

  // ctx: the media context built by js/media.js, or null/empty when nothing is
  // playing (the segment then hides itself — an empty now-playing block in the
  // topbar is noise, and the media tile already carries the empty state).
  function sync(ctx) {
    const h = host();
    if (!h) return;
    // Markup replaced under us — the cached nodes AND the text we think they
    // hold are both stale, so the next update must write into the new ones.
    if (els && els.host !== h) { els = null; lastText = ''; }
    const active = !!(ctx && !ctx.empty && (ctx.title || ctx.artist || ctx.app));
    if (!active) {
      playing = false;
      durSec = 0;
      syncTicker();
      close(h);
      return;
    }
    if (!els) build(h);
    const main = ctx.title || ctx.app || '';
    const sub = ctx.artist || ctx.app || '';
    // Only a real track change repaints the text, and only then does it
    // cross-fade: media updates arrive on every SSE sample, and re-triggering a
    // transition on each one would leave it running for as long as music plays.
    const text = main + ' ' + sub;
    if (text !== lastText) {
      const first = !lastText;
      lastText = text;
      // Bound to THESE nodes, not to `els`, so a rebuild mid-fade cannot make the
      // deferred write land in markup that was never faded out.
      const txtEl = els.txt, titleEl = els.title, artistEl = els.artist;
      const write = () => {
        titleEl.textContent = main;
        artistEl.textContent = sub;
        artistEl.hidden = !sub;
      };
      clearTimeout(swapTimer);
      if (first || reducedMotion()) {
        write();
      } else {
        txtEl.classList.add('tbm-swap');
        swapTimer = setTimeout(() => { write(); txtEl.classList.remove('tbm-swap'); }, 160);
      }
    }
    if (ctx.thumb) {
      els.art.style.backgroundImage = 'url("' + ctx.thumb + '")';
      els.art.hidden = false;
    } else {
      els.art.style.backgroundImage = '';
      els.art.hidden = true;
    }
    // Read the takeover BEFORE `playing` moves — it is what the answer depends on.
    const wasOver = takingOver();
    playing = ctx.playing === true;
    els.play.classList.toggle('is-playing', playing);
    durSec = Number(ctx.duration) > 0 ? Number(ctx.duration) : 0;
    posSec = Number(ctx.position) > 0 ? Number(ctx.position) : 0;
    posAt = Date.now();
    // Starting or ending the takeover swaps which segments the capsule holds, so
    // it is a structural change: paint it through the island morph, which fades
    // the pill's contents out, exchanges them unseen and glides the box between
    // the two sizes. Everything the swap touches has to happen INSIDE that
    // callback — `paintProgress` owns the .tbm-takeover class and `open` can
    // expand the segment — or the capsule is measured mid-change and the morph
    // travels to the wrong size.
    //
    // Only on the flip. Media updates arrive on every sample; running the morph
    // (or even the plain relayout, which reflows the grid) on each one would
    // never let the pill sit still.
    if (takingOver() !== wasOver) {
      const swap = () => { paintProgress(); open(h); relayout(); };
      const tm = window.TopbarMinimal;
      if (tm && typeof tm.morphIsland === 'function') tm.morphIsland(swap);
      else swap();
    } else {
      paintProgress();
      open(h);
    }
    syncTicker();
  }

  // Settings changed (the takeover toggle, or a segment's visibility): re-decide
  // whether the player owns the capsule, and re-run the island layout so the
  // other segments come back or step aside to match.
  function apply() {
    paintProgress();
    syncTicker();
    relayout();
  }

  window.TopbarMedia = { sync, apply, takingOver };
})();
