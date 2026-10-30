'use strict';
// Song lyrics: one renderer for both surfaces (the Media tile's sheet and the
// Lyrics widget). It draws a LyricsCore snapshot and never fetches or times
// anything itself.
//
// The synced list is a track inside an overflow:hidden viewport, moved with
// transform: translateY so the active line sits a little above the middle —
// never scrollTop, which the browser may silently drop (rendering invariants).
// Depth comes from opacity and a small scale only: no filter, no blur, and the
// same font weight on every line so the active line never rewraps.
(function () {
  const ANCHOR = 0.38;            // active line centre, as a share of the viewport height
  const DRAG_THRESHOLD_PX = 6;
  const FOLLOW_RESUME_MS = 4000;
  const MOVE_SETTLE_MS = 600;     // longer than the CSS transition
  // Word-by-word light-up; the moments are estimated in LyricsCore.wordStarts.
  const WORD_FADE_MS = 180;
  const WORD_KEYFRAMES = [{ opacity: 0.4 }, { opacity: 1 }];
  const FROZEN = '.overlay-frozen, .game-mode, .low-power-gpu';

  const t = (k) => (typeof window.t === 'function' ? window.t(k) : k);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  // Each state the list cannot show: message key and the optional action.
  const STATUS = {
    idle: { msg: 'lyrics_idle' },
    off: { msg: 'lyrics_off', action: 'lyrics_open_settings' },
    live: { msg: 'lyrics_live' },
    none: { msg: 'lyrics_none' },
    instrumental: { msg: 'lyrics_instrumental' },
    busy: { msg: 'lyrics_unreachable', action: 'lyrics_retry' },
    error: { msg: 'lyrics_unreachable', action: 'lyrics_retry' },
  };

  function create(host, opts) {
    const compact = !!(opts && opts.compact);
    const root = el('div', 'lyv' + (compact ? ' is-compact' : ''));
    const viewport = el('div', 'lyv-viewport');
    const track = el('div', 'lyv-track');
    viewport.appendChild(track);

    const skeleton = el('div', 'lyv-skel');
    skeleton.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) skeleton.appendChild(el('span', 'lyv-skel-bar'));

    const status = el('div', 'lyv-status');
    const statusText = el('p', 'lyv-status-text');
    const statusBtn = el('button', 'lyv-status-btn');
    statusBtn.type = 'button';
    status.append(statusText, statusBtn);

    const foot = el('div', 'lyv-foot');
    const note = el('span', 'lyv-note', '');
    const credit = el('span', 'lyv-credit', '');
    const follow = el('button', 'lyv-follow', '');
    follow.type = 'button';
    follow.hidden = true;
    foot.append(note, credit, follow);

    root.append(viewport, skeleton, status, foot);
    host.appendChild(root);

    let snap = null;
    let builtKey = null;
    let following = true;
    let manualY = 0;
    let baseY = 0;
    let resumeTimer = null;
    let settleTimer = null;
    let placedY = null;
    let drag = null;
    let swallowClick = false;
    let run = null;                 // the line whose words are lighting: { row, playing, epoch, anims }
    let extras = null;              // { tr: [], read: [] } by the server's line order, or null

    // ── list building ───────────────────────────────────────────────────
    function buildSynced(lines) {
      const frag = document.createDocumentFragment();
      lines.forEach((line, i) => {
        if (!line.text) {
          // Only a pause long enough to notice gets the dots; a short breath
          // between two lines takes no room.
          const next = lines[i + 1];
          const long = !!next && next.t - line.t >= window.LyricsCore.GAP_MIN_MS;
          const gap = el('div', 'lyv-gap' + (long ? '' : ' is-short'));
          gap.dataset.i = String(i);
          for (let d = 0; d < window.LyricsCore.GAP_STEPS; d++) gap.appendChild(el('span', 'lyv-dot'));
          frag.appendChild(gap);
          return;
        }
        const b = el('button', 'lyv-line');
        b.type = 'button';
        // One span per word, the spaces kept as text so the line wraps as before.
        line.text.split(/(\s+)/).forEach(part => {
          if (!part) return;
          b.appendChild(/^\s+$/.test(part) ? document.createTextNode(part) : el('span', 'lyv-w', part));
        });
        b.appendChild(subRow());
        b.dataset.i = String(i);
        if (Number.isInteger(line.src)) b.dataset.src = String(line.src);
        frag.appendChild(b);
      });
      track.replaceChildren(frag);
    }

    function buildPlain(plain) {
      const frag = document.createDocumentFragment();
      plain.forEach((text, i) => {
        const p = el('p', 'lyv-plain-line' + (text ? '' : ' is-blank'));
        if (text) {
          p.append(document.createTextNode(text), subRow());
          p.dataset.src = String(i);
        }
        frag.appendChild(p);
      });
      track.replaceChildren(frag);
    }

    // ── reading and translation under a line (supporter widget only) ─────
    function subRow() {
      const sub = el('span', 'lyv-sub');
      sub.append(el('span', 'lyv-read'), el('span', 'lyv-tr'));
      sub.hidden = true;
      return sub;
    }

    function paintExtras() {
      const read = (extras && extras.read) || [];
      const tr = (extras && extras.tr) || [];
      for (const row of track.children) {
        const sub = row.querySelector('.lyv-sub');
        if (!sub) continue;
        const src = Number(row.dataset.src);
        const r = Number.isInteger(src) && typeof read[src] === 'string' ? read[src] : '';
        const x = Number.isInteger(src) && typeof tr[src] === 'string' ? tr[src] : '';
        sub.children[0].textContent = r;
        sub.children[0].hidden = !r;
        sub.children[1].textContent = x;
        sub.children[1].hidden = !x;
        sub.hidden = !r && !x;
      }
      // Rows changed height: the active line must sit at the anchor again.
      if (snap && snap.state === 'synced' && following) { baseY = anchorFor(snap.index); place(baseY, false); }
    }

    function setExtras(next) {
      extras = next && (Array.isArray(next.tr) || Array.isArray(next.read)) ? next : null;
      root.classList.toggle('has-extras', !!extras);
      if (builtKey) paintExtras();
    }

    // ── positioning ─────────────────────────────────────────────────────
    function anchorFor(index) {
      const rows = track.children;
      const row = rows[Math.max(0, index)];
      if (!row) return 0;
      return viewport.clientHeight * ANCHOR - (row.offsetTop + row.offsetHeight / 2);
    }

    function clampY(y) {
      const min = Math.min(0, viewport.clientHeight * ANCHOR - track.scrollHeight);
      const max = viewport.clientHeight * ANCHOR;
      return Math.max(min, Math.min(max, y));
    }

    // Every media poll re-renders; only a real move may touch the track, or
    // will-change would be switched on again each second for nothing.
    function place(y, animate) {
      const next = Math.round(y);
      if (next === placedY) return;
      placedY = next;
      track.classList.toggle('is-moving', !!animate);
      track.classList.toggle('no-anim', !animate);
      track.style.setProperty('--lyv-y', next + 'px');
      clearTimeout(settleTimer);
      if (animate) settleTimer = setTimeout(() => track.classList.remove('is-moving'), MOVE_SETTLE_MS);
    }

    function paintActive() {
      const index = snap.index;
      for (const row of track.children) {
        const i = Number(row.dataset.i);
        row.classList.toggle('is-active', i === index);
        row.classList.toggle('is-past', i < index);
        if (row.classList.contains('lyv-gap')) {
          const step = i === index ? snap.gapStep : (i < index ? window.LyricsCore.GAP_STEPS : -1);
          [...row.children].forEach((dot, d) => dot.classList.toggle('is-on', d <= step));
        }
      }
      paintWords(index);
      if (following) { baseY = anchorFor(index); place(baseY, true); }
    }

    // ── word by word ────────────────────────────────────────────────────
    // Every word gets one short opacity animation that starts at its own delay
    // from NOW; a negative delay (joined mid-line) lands it already lit. No
    // frame loop. These are Web Animations, not CSS ones, on purpose: Chromium
    // (WebView2 too) rebuilt the CSS animations from scratch every time the
    // Media tile re-laid out inside its size container (each second, when the
    // Spotify seek bar ticked), so lit words went dim and lit again. Script
    // animations survive style and layout passes.
    function startWords(row, i) {
      stopWords();
      const anims = [];
      run = { row, playing: snap.playing, epoch: window.LyricsCore.clockEpoch(), anims };
      if (typeof row.animate !== 'function' || document.body.matches(FROZEN)) return;
      const words = row.querySelectorAll('.lyv-w');
      const pos = window.LyricsCore.positionMs();
      const start = snap.lines[i].t;
      const next = snap.lines[i + 1];
      const offs = window.LyricsCore.wordStarts([...words].map(w => w.textContent), next ? next.t - start : null);
      const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      words.forEach((w, j) => {
        const a = w.animate(WORD_KEYFRAMES, {
          duration: still ? 0 : WORD_FADE_MS,
          // Centre the fade on the word's moment, so it reads lit as it is sung.
          delay: Math.round(start + offs[j] - pos - WORD_FADE_MS / 2),
          easing: 'ease-out',
          fill: 'both',
        });
        if (!snap.playing) a.pause();
        anims.push(a);
      });
    }

    function stopWords() {
      if (run) run.anims.forEach(a => a.cancel());
      run = null;
    }

    function paintWords(index) {
      const row = track.querySelector('.lyv-line[data-i="' + index + '"]');
      if (!row) { stopWords(); return; }
      if (!run || run.row !== row) { startWords(row, index); return; }
      if (!snap.playing) { run.anims.forEach(a => a.pause()); return; }   // they hold where they are
      // Only a real jump retimes the words. Re-timing on every small correction
      // of the clock would put lit words back to dim and light them again.
      if (!run.playing || run.epoch !== window.LyricsCore.clockEpoch()) startWords(row, index);
    }

    // ── following and manual scroll ─────────────────────────────────────
    function setFollowing(on) {
      following = on;
      follow.hidden = on || !snap || snap.state !== 'synced';
      clearTimeout(resumeTimer);
      if (on && snap && snap.state === 'synced') { baseY = anchorFor(snap.index); place(baseY, true); }
    }

    function holdManual() {
      if (following) setFollowing(false);
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => setFollowing(true), FOLLOW_RESUME_MS);
    }

    function onPointerDown(e) {
      if (!snap || snap.state !== 'synced' || e.button > 0) return;
      drag = { id: e.pointerId, y0: e.clientY, from: following ? baseY : manualY, moved: false };
    }
    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y0;
      if (!drag.moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      if (!drag.moved) { drag.moved = true; try { viewport.setPointerCapture(e.pointerId); } catch {} }
      holdManual();
      manualY = clampY(drag.from + dy);
      place(manualY, false);
    }
    function onPointerUp(e) {
      if (!drag || e.pointerId !== drag.id) return;
      swallowClick = drag.moved;
      drag = null;
    }
    function onWheel(e) {
      if (!snap || snap.state !== 'synced') return;
      e.preventDefault();
      if (following) manualY = baseY;
      holdManual();
      manualY = clampY(manualY - e.deltaY);
      place(manualY, false);
    }
    // A drag past the threshold must not also seek to the line it ended on.
    function onClickCapture(e) {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
    function onClick(e) {
      const line = e.target.closest('.lyv-line');
      if (!line || !snap || snap.state !== 'synced') return;
      setFollowing(true);
      window.LyricsCore.seekToLine(Number(line.dataset.i));
    }

    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('click', onClickCapture, true);
    viewport.addEventListener('click', onClick);
    follow.addEventListener('click', () => setFollowing(true));
    statusBtn.addEventListener('click', () => {
      if (!snap) return;
      if (snap.state === 'off') { if (typeof openSettingsCategory === 'function') openSettingsCategory('appearance'); }
      else window.LyricsCore.retry();
    });

    const ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => { if (snap && snap.state === 'synced' && following) { baseY = anchorFor(snap.index); place(baseY, false); } })
      : null;
    if (ro) ro.observe(viewport);

    // ── render ──────────────────────────────────────────────────────────
    function render(next) {
      snap = next;
      const state = snap.state;
      root.dataset.state = state;
      const listed = state === 'synced' || state === 'plain';
      viewport.hidden = !listed;
      skeleton.hidden = state !== 'loading';
      const info = STATUS[state];
      status.hidden = !info;
      if (info) {
        statusText.textContent = t(info.msg);
        statusBtn.hidden = !info.action;
        if (info.action) statusBtn.textContent = t(info.action);
      }
      foot.hidden = !listed;
      credit.textContent = t('lyrics_credit');
      note.textContent = state === 'plain' ? t('lyrics_not_synced') : '';
      note.hidden = state !== 'plain';
      follow.textContent = t('lyrics_follow');
      viewport.classList.toggle('is-plain', state === 'plain');

      if (!listed) { builtKey = null; stopWords(); track.replaceChildren(); return; }
      const key = state + '|' + snap.key;
      if (key !== builtKey) {
        builtKey = key;
        stopWords();
        if (state === 'synced') buildSynced(snap.lines); else buildPlain(snap.plain);
        following = true;
        follow.hidden = true;
        if (extras) paintExtras();
        place(state === 'synced' ? anchorFor(snap.index) : 0, false);
      }
      if (state === 'synced') paintActive();
    }

    function destroy() {
      stopWords();
      clearTimeout(resumeTimer);
      clearTimeout(settleTimer);
      if (ro) ro.disconnect();
      root.remove();
    }

    return { render, destroy, setExtras, root };
  }

  window.LyricsView = { create };
})();
