'use strict';
// The Playback widget's progress line: how far into the track, how long it is,
// and a tap or drag to jump. It reads the shared media clock in media.js
// (currentMediaPositionMs), so it never asks the host for anything; its one
// ticker runs once a second, and only while a line is on screen and the track
// is playing. A track with no length (a live stream, a radio) shows no line.
// The line is drawn on the Liquid look only (LiquidPlayer.css); elsewhere it is
// display:none, which also keeps the ticker off. The Spotify strip has its own
// seek bar, so the line steps aside while that strip shows (CSS too).
(function () {
  const TICK_MS = 1000;
  const SEEK_DEADLINE_MS = 10000;
  let timer = null;
  let dragging = null;     // the range under a finger, left alone by the ticker
  let refused = '';        // the track whose player said no to a seek
  const wired = new WeakSet();
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(() => sync(), { threshold: 0.01 })
    : null;

  const data = () => (typeof mediaData === 'object' && mediaData) ? mediaData : null;
  const active = () => typeof hasActiveMedia === 'function' && hasActiveMedia();
  const durationMs = () => Math.max(0, Number(data() && data().duration) || 0) * 1000;
  const playing = () => active() && data().playbackStatus === 'Playing';
  const positionMs = () => Math.min(durationMs(), typeof currentMediaPositionMs === 'function' ? currentMediaPositionMs() : 0);
  const trackKey = () => {
    const d = data();
    return d ? `${d.app || ''}|${d.title || ''}|${d.artist || d.album || ''}` : '';
  };

  function roots() {
    const list = [];
    if (typeof eachMedia === 'function') eachMedia((root) => list.push(root));
    return list;
  }

  // "4:05", or "1:02:09" for an hour or more (a podcast, a long mix).
  function fmt(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function parts(root) {
    const box = root.querySelector('[data-mf="media-progress"]');
    if (!box) return null;
    return {
      box,
      range: box.querySelector('[data-mf="media-progress-range"]'),
      pos: box.querySelector('[data-mf="media-pos"]'),
      dur: box.querySelector('[data-mf="media-dur"]'),
    };
  }

  function show(p, ms, dur) {
    p.range.style.setProperty('--mp-fill', `${dur ? Math.min(100, (ms / dur) * 100).toFixed(2) : 0}%`);
    p.pos.textContent = fmt(ms);
  }

  function paint(root) {
    const p = parts(root);
    if (!p || !p.range) return;
    wire(p);
    const dur = durationMs();
    p.box.hidden = !(active() && dur > 0);
    if (p.box.hidden || p.range === dragging) return;
    const ms = positionMs();
    p.range.max = String(Math.round(dur / 1000));
    p.range.value = String(Math.floor(ms / 1000));
    p.range.disabled = refused === trackKey();
    p.dur.textContent = fmt(dur);
    show(p, ms, dur);
  }

  function visible(root) {
    const p = parts(root);
    return !!(p && !p.box.hidden && p.box.offsetParent !== null && !document.hidden
      && (typeof onVisiblePage !== 'function' || onVisiblePage(root)));
  }

  function wanted(list) {
    return playing() && durationMs() > 0 && list.some(visible);
  }

  function tick() {
    const list = roots();
    if (!wanted(list)) { stop(); return; }
    list.forEach(paint);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Called by media.js on every media update, and on page, tab and window
  // visibility changes: repaint now, then tick only while it is worth it.
  function sync() {
    const list = roots();
    list.forEach(paint);
    if (wanted(list)) { if (!timer) timer = setInterval(tick, TICK_MS); } else stop();
  }

  async function seek(seconds) {
    const key = trackKey();
    let reply = null;
    try {
      const res = await fetchWithDeadline(SERVER + '/actions/run', SEEK_DEADLINE_MS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'mediaSeek', position: seconds }),
      });
      reply = await res.json();
    } catch { reply = null; }
    if (reply && reply.ok) {
      if (typeof noteMediaSeek === 'function') noteMediaSeek(seconds * 1000);
    } else {
      // A player that refuses the timeline refuses it for the whole track: the
      // line keeps showing where it is but stops offering to move.
      if (reply && reply.error === 'not_seekable') refused = key;
      if (typeof showHubToast === 'function') {
        showHubToast((data() && data().app) || t('layout_widget_media'), t('lyrics_seek_failed'), '');
      }
    }
    sync();
  }

  function wire(p) {
    if (wired.has(p.range)) return;
    wired.add(p.range);
    if (io) io.observe(p.box);
    // A drag the browser takes over for a scroll ends with no change event.
    const release = () => { if (dragging === p.range) dragging = null; };
    p.range.addEventListener('input', () => {
      dragging = p.range;
      show(p, Number(p.range.value) * 1000, durationMs());
    });
    p.range.addEventListener('change', () => {
      release();
      seek(Math.max(0, Math.floor(Number(p.range.value) || 0)));
    });
    p.range.addEventListener('pointercancel', release);
    p.range.addEventListener('blur', release);
  }

  document.addEventListener('visibilitychange', sync);
  window.addEventListener('xenon:page-change', sync);
  window.MediaProgress = { sync, fmt };
})();
