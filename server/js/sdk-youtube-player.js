'use strict';
// The host's YouTube player, lent to a community widget.
//
// A widget cannot embed YouTube itself: its frame is sandboxed with an opaque
// origin and a CSP that blocks all network, which is the whole reason the SDK is
// safe to install things into. So a widget that wants a video inside its own
// layout has to ask the HOST to put one there — which is what this is. Xenon
// creates the embed, owns it, and the widget only ever sends validated commands
// and receives state back. Requested by the author of a YouTube widget who had
// built a private version of exactly this and wanted to delete it.
//
// WHERE IT GOES. The widget reports a rectangle in its OWN viewport, and the
// player is placed over the widget's frame at that rectangle. The frame fills
// .cw-body, so the two coordinate systems are the same one and no scaling maths
// is involved — a transform on the tile scales the player with the frame,
// because they are siblings in the same box.
//
// PLAYBACK. Same protocol the built-in YouTube tile uses: the official embed,
// driven over postMessage, with no third-party script loaded into the dashboard.
// Messages are accepted only from the embed origin and only from our own frame.
//
// THE RULES, all of them enforced here rather than trusted from the widget:
//   · one player at a time on this dashboard — a second widget asking takes it
//     over, and the first is told, so two videos can never talk at once
//   · a video id is a video id (no urls, no query strings)
//   · a rectangle is clamped into the tile, with a floor on its size: a widget
//     may not shrink the player to a pixel and use it as an invisible speaker
//   · the tile has to be on screen — a hidden tile's player is torn down, not
//     left playing behind the dashboard
(function () {
  const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
  const PLAYER_ID = 'xenon-sdk-yt';
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,24}$/;
  const MIN_W = 96;                 // a player smaller than this is not a player
  const MIN_H = 54;
  const POSITION_MS = 900;          // infoDelivery arrives ~4x/s; the widget gets ~1
  const STATES = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };

  // The single player. `owner` is whatever custom-widget.js passed as identity —
  // an object, compared by reference, so nothing a widget can say identifies it.
  let cur = null;   // { owner, host, box, frame, video, onEvent, state, time, duration, muted, heard, hello, lastPos }

  function post(msg) {
    const f = cur && cur.frame;
    if (!f || !f.contentWindow) return;
    try { f.contentWindow.postMessage(JSON.stringify(Object.assign({ id: PLAYER_ID, channel: 'widget' }, msg)), EMBED_ORIGIN); }
    catch { /* frame torn down mid-command */ }
  }
  function cmd(func, args) { post({ event: 'command', func, args: args || [] }); }

  // The embed reports nothing until we say we are listening, and can miss the
  // first hello while it boots — so it is repeated until it answers.
  function sayHello() {
    if (!cur) return;
    clearInterval(cur.hello);
    let n = 0;
    const tick = () => {
      if (!cur || !cur.frame || !cur.frame.contentWindow) return;
      if (++n > 20) { clearInterval(cur.hello); cur.hello = null; return; }
      post({ event: 'listening' });
    };
    cur.hello = setInterval(tick, 400);
    tick();
  }

  function emit(event, extra) {
    if (!cur || typeof cur.onEvent !== 'function') return;
    const base = {
      event,
      video: cur.video,
      state: STATES[String(cur.state)] || 'unstarted',
      position: Math.max(0, Math.round((cur.time || 0) * 10) / 10),
      duration: Math.max(0, Math.round((cur.duration || 0) * 10) / 10),
      muted: !!cur.muted,
    };
    try { cur.onEvent(Object.assign(base, extra || {})); } catch { /* the widget is gone */ }
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== EMBED_ORIGIN) return;
    if (!cur || !cur.frame || !cur.frame.contentWindow || e.source !== cur.frame.contentWindow) return;
    let d = null;
    try { d = JSON.parse(typeof e.data === 'string' ? e.data : ''); } catch { return; }
    if (!d || typeof d !== 'object') return;
    cur.heard = true;
    if (cur.hello) { clearInterval(cur.hello); cur.hello = null; }
    const info = d.info;
    if (d.event === 'onStateChange') {
      applyState(Number(info));
    } else if (d.event === 'onError') {
      // Nothing to retry, and the widget is the one drawing the surface around
      // the player — so it gets the code and decides what to say. 101/150 mean
      // the owner disallowed embedding; the rest are about this player or this
      // installation. (The built-in tile keeps its own memory of refusals; this
      // one does not, because the widget holds the list it is drawing.)
      emit('error', { code: Number(info) || 0 });
    } else if (d.event === 'infoDelivery' || d.event === 'initialDelivery') {
      if (info && typeof info === 'object') {
        if (typeof info.currentTime === 'number') cur.time = info.currentTime;
        if (typeof info.duration === 'number' && info.duration > 0) cur.duration = info.duration;
        if (typeof info.muted === 'boolean') cur.muted = info.muted;
        if (typeof info.playerState === 'number' && Number(info.playerState) !== cur.state) { applyState(Number(info.playerState)); return; }
        // Position is a firehose (several a second) and a widget drawing a
        // progress bar needs about one. The state changes above are never
        // throttled — those are the events something depends on.
        const now = Date.now();
        if (now - (cur.lastPos || 0) >= POSITION_MS) { cur.lastPos = now; emit('position'); }
      }
    }
  });

  function applyState(next) {
    if (!cur || !Number.isFinite(next) || next === cur.state) return;
    cur.state = next;
    emit(next === 0 ? 'ended' : 'state');
  }

  // ── The surface ─────────────────────────────────────────────────────────────
  function clampRect(box, r) {
    const bw = Math.max(0, box.clientWidth);
    const bh = Math.max(0, box.clientHeight);
    const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
    let w = Math.round(num(r && r.w, bw));
    let h = Math.round(num(r && r.h, bh));
    let x = Math.round(num(r && r.x, 0));
    let y = Math.round(num(r && r.y, 0));
    // A tile too small to hold a player at all is a refusal, not a squeeze: the
    // alternative is a player hanging over the edge of someone's dashboard.
    if (bw < MIN_W || bh < MIN_H) return null;
    w = Math.min(Math.max(w, MIN_W), bw);
    h = Math.min(Math.max(h, MIN_H), bh);
    x = Math.min(Math.max(x, 0), bw - w);
    y = Math.min(Math.max(y, 0), bh - h);
    return { x, y, w, h };
  }

  function place(rect) {
    if (!cur || !cur.frame) return;
    const s = cur.frame.style;
    s.left = rect.x + 'px'; s.top = rect.y + 'px';
    s.width = rect.w + 'px'; s.height = rect.h + 'px';
  }

  function teardown(reason) {
    if (!cur) return;
    const gone = cur;
    cur = null;                       // cleared FIRST: emit() and the message
    clearInterval(gone.hello);        // listener must not see a half-dead player
    try { if (gone.frame && gone.frame.parentNode) gone.frame.parentNode.removeChild(gone.frame); } catch { /* already gone */ }
    if (typeof gone.onEvent === 'function') {
      try { gone.onEvent({ event: 'closed', reason: reason || 'closed', video: gone.video, state: 'unstarted', position: 0, duration: 0, muted: false }); }
      catch { /* the widget is gone, which is often WHY we are closing */ }
    }
  }

  function mount(owner, box, video, rect, onEvent) {
    teardown('replaced');
    const f = document.createElement('iframe');
    f.className = 'sdk-yt-frame';
    f.title = 'YouTube';
    // No fullscreen permission, for the same reason the built-in tile withholds
    // it: on the kiosk the browser's own fullscreen tears the video down and
    // leaves a window the taskbar sits on top of. Withholding it is what hides
    // YouTube's fullscreen button.
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    const p = new URLSearchParams({
      enablejsapi: '1', autoplay: '1', rel: '0', playsinline: '1',
      modestbranding: '1', origin: location.origin, widget_referrer: location.origin,
    });
    f.src = EMBED_ORIGIN + '/embed/' + encodeURIComponent(video) + '?' + p.toString();
    f.addEventListener('load', sayHello);
    cur = { owner, host: box, frame: f, video, onEvent, state: -1, time: 0, duration: 0, muted: false, heard: false, hello: null, lastPos: 0 };
    place(rect);
    box.appendChild(f);
    sayHello();
  }

  // ── What custom-widget.js calls ─────────────────────────────────────────────
  // `op` is already known to be one of ours; every VALUE inside params is
  // validated here, because this is where it becomes a URL or a command.
  function exec(owner, box, op, params, onEvent) {
    const p = params && typeof params === 'object' ? params : {};
    const mine = alive() && cur.owner === owner;

    if (op === 'hide') { if (mine) teardown('hidden'); return { ok: true }; }

    if (op === 'show' || op === 'load') {
      const video = String(p.video == null ? '' : p.video).trim();
      if (!VIDEO_ID_RE.test(video)) return { ok: false, error: 'bad_video' };
      if (!box || !box.isConnected) return { ok: false, error: 'unavailable' };
      const rect = clampRect(box, p);
      if (!rect) return { ok: false, error: 'too_small' };
      // `load` into a player that is already ours and already up swaps the video
      // without a new frame: the embed keeps its handshake, so playback starts
      // immediately instead of after another boot. Everything else remounts.
      if (op === 'load' && mine && cur.frame && cur.heard) {
        cur.video = video; cur.state = -1; cur.time = 0; cur.duration = 0;
        place(rect);
        cmd('loadVideoById', [video]);
        return { ok: true };
      }
      mount(owner, box, video, rect, onEvent);
      return { ok: true };
    }

    if (!mine) return { ok: false, error: 'no_player' };

    if (op === 'rect') {
      const rect = clampRect(box, p);
      if (!rect) return { ok: false, error: 'too_small' };
      place(rect);
      return { ok: true };
    }
    if (op === 'play') { cmd('playVideo'); return { ok: true }; }
    if (op === 'pause') { cmd('pauseVideo'); return { ok: true }; }
    if (op === 'mute') {
      const on = p.muted !== false;
      cmd(on ? 'mute' : 'unMute');
      cur.muted = on;
      return { ok: true };
    }
    if (op === 'seek') {
      // A number, not something that converts to one: `null` and `''` both become
      // 0, and a widget sending either has a bug we should report rather than
      // answer by jumping to the start of the video.
      const secs = p.seconds;
      if (typeof secs !== 'number' || !Number.isFinite(secs) || secs < 0) return { ok: false, error: 'bad_seconds' };
      cmd('seekTo', [Math.min(secs, 86400), true]);
      return { ok: true };
    }
    return { ok: false, error: 'bad_op' };
  }

  // The widget went away (unmounted, swapped, uninstalled, permission revoked,
  // tile hidden). Its player goes with it — a video playing on behalf of a widget
  // that is no longer on the dashboard is a speaker nobody can reach.
  // The host frame can be taken out from under us — .cw-body is rebuilt whenever
  // a widget remounts (package swapped, files reloaded), which removes the player
  // along with the guest frame. A detached player is not a player: notice it here
  // rather than sending commands into a node nobody is looking at.
  function alive() {
    if (cur && cur.frame && !cur.frame.isConnected) teardown('gone');
    return !!cur;
  }
  function release(owner) { if (alive() && cur.owner === owner) teardown('gone'); }
  // "Whoever has it, take it back." The caller has established that no widget on
  // this dashboard should be holding a player — an owner that is no longer in the
  // frame table cannot be named, only closed.
  function closeAny() { if (alive()) teardown('gone'); }
  function owns(owner) { return alive() && cur.owner === owner; }
  function active() { return alive(); }

  window.SdkYouTubePlayer = { exec, release, closeAny, owns, active };
})();
