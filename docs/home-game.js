// The two things on the home that move by themselves below the hero: the small
// game under the real overlay and the Maker clip. Both run only in view, never
// under reduced motion, and each has a pause button (WCAG 2.2.2). The game is a
// scene of our own, drawn in code: no real game's footage or art on the site.
(function () {
  'use strict';

  const FRAME_MS = 33;
  const REPLAY_EVERY_MS = 9000;
  const REPLAY_SHOWN_MS = 2400;
  const FIRST_REPLAY_DELAY_MS = 3000;
  const WARM_UP_STEPS = 260;
  const JUMP_FRAMES = 38;
  const JUMP_HEIGHT = 52;
  const BIT_PIXEL = 3;
  const BIT_X = 150;

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canObserve = 'IntersectionObserver' in window;

  function pauseButton(button, onChange) {
    if (!button) return;
    if (reduce || !canObserve) { button.hidden = true; return; }
    button.addEventListener('click', () => {
      const paused = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(paused));
      onChange(paused);
    });
  }

  function makerClip() {
    const video = document.querySelector('video[data-play]');
    if (!video) return;
    const button = document.getElementById('maker-pause');
    if (reduce || !canObserve) { if (button) button.hidden = true; return; }
    let paused = false;
    let inView = false;
    const sync = () => { if (inView && !paused) video.play().catch(() => {}); else video.pause(); };
    pauseButton(button, (p) => { paused = p; sync(); });
    new IntersectionObserver((es) => { inView = es[0].isIntersecting; sync(); }, { threshold: 0.25 }).observe(video);
  }

  function game() {
    const cv = document.getElementById('game');
    if (!cv) return;
    const g = cv.getContext('2d');
    const WD = cv.width;
    const HT = cv.height;
    const GROUND = 156;
    const rnd = (n) => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };
    const BODY = [[4, 0, 1, 2], [1, 2, 6, 1], [0, 3, 8, 6], [1, 9, 6, 1]];
    const FACE = [[2, 4, 1, 2], [5, 4, 1, 2], [2, 7, 1, 1], [3, 8, 2, 1], [5, 7, 1, 1]];
    const SKY = [['#141A3C', 0, 46], ['#1C2552', 46, 30], ['#2A3470', 76, 24], ['#44478A', 100, 22], ['#7A5C9C', 122, 18], ['#C4768E', 140, 16]];
    const px = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
    const stars = Array.from({ length: 70 }, (_, i) => [rnd(i) * WD, rnd(i + 99) * 104, rnd(i + 7) > 0.7 ? 2 : 1]);
    const ridge = (x, seed, h) => {
      const n = Math.floor(x / 14);
      const a = rnd(n + seed);
      const b = rnd(n + 1 + seed);
      return Math.floor((a + (b - a) * ((x % 14) / 14)) * h / 4) * 4;
    };
    let sparks = [];
    let rocks = [];
    let t = 0;
    let jump = 0;
    let scroll = 0;
    let nextSpark = 40;
    let nextRock = 180;

    const jumpY = () => (jump > 0 ? Math.sin((jump / JUMP_FRAMES) * Math.PI) * JUMP_HEIGHT : 0);

    function drawSky() {
      SKY.forEach(([c, y, h]) => px(0, y, WD, h, c));
      stars.forEach(([x, y, s]) => px((x - scroll * 0.04 + WD * 8) % WD, y, s, s, '#D8DEFF'));
      px(378, 24, 26, 26, '#FFE9B0'); px(374, 28, 34, 18, '#FFE9B0'); px(382, 20, 18, 34, '#FFE9B0');
      px(386, 30, 5, 5, '#F0CF8E'); px(394, 40, 4, 4, '#F0CF8E');
    }

    function drawTown() {
      const off = scroll * 0.8;
      const first = Math.floor(off / 46) - 1;
      for (let i = first; i < first + 14; i++) {
        if (rnd(i + 5) < 0.42) continue;
        const bx = i * 46 - off;
        const h = 24 + Math.floor(rnd(i) * 7) * 6;
        const w = 24 + Math.floor(rnd(i + 2) * 3) * 6;
        px(bx, GROUND - h, w, h, '#12143A');
        for (let wy = GROUND - h + 5; wy < GROUND - 6; wy += 7) {
          for (let wx = bx + 4; wx < bx + w - 4; wx += 6) {
            if (rnd(wx - bx + wy * 3 + i) > 0.55) px(wx, wy, 3, 3, '#FFD75E');
          }
        }
      }
    }

    function drawHills() {
      for (let x = 0; x < WD; x += 2) {
        const far = ridge(x + scroll * 0.25, 3, 50);
        px(x, GROUND - 34 - far, 2, far + 40, '#2E2E6E');
      }
      for (let x = 0; x < WD; x += 2) {
        const near = ridge(x + scroll * 0.55, 40, 34);
        px(x, GROUND - 14 - near, 2, near + 20, '#1D1F52');
      }
      drawTown();
    }

    function drawGround() {
      px(0, GROUND, WD, HT - GROUND, '#0C0E28');
      px(0, GROUND, WD, 4, '#6EE787');
      px(0, GROUND + 4, WD, 2, '#2C8A4A');
      const off = scroll % 24;
      for (let x = -off; x < WD; x += 24) { px(x, GROUND + 12, 12, 3, '#1A1E4A'); px(x + 10, GROUND + 22, 8, 3, '#161A40'); }
    }

    function drawBit(x, y, frame) {
      BODY.forEach(([a, b, w, h]) => px(x + a * BIT_PIXEL, y + b * BIT_PIXEL, w * BIT_PIXEL, h * BIT_PIXEL, '#6EE787'));
      const lift = jump > 0 ? [0, 0] : (frame ? [BIT_PIXEL, 0] : [0, BIT_PIXEL]);
      px(x + BIT_PIXEL, y + 10 * BIT_PIXEL - lift[0], 2 * BIT_PIXEL, BIT_PIXEL, '#6EE787');
      px(x + 5 * BIT_PIXEL, y + 10 * BIT_PIXEL - lift[1], 2 * BIT_PIXEL, BIT_PIXEL, '#6EE787');
      FACE.forEach(([a, b, w, h]) => px(x + a * BIT_PIXEL, y + b * BIT_PIXEL, w * BIT_PIXEL, h * BIT_PIXEL, '#0D1117'));
    }

    function drawSpark(x, y, on) {
      const c = on ? '#FFD75E' : '#FFF2B8';
      px(x + 3, y, 2, 8, c); px(x, y + 3, 8, 2, c); px(x + 2, y + 2, 4, 4, c);
    }

    function drawRock(x, h) {
      px(x, GROUND - h, 14, h, '#FF5A5F');
      px(x + 3, GROUND - h - 4, 8, 4, '#FF5A5F');
      px(x + 3, GROUND - h + 3, 3, 3, '#7A1E2A');
      px(x + 9, GROUND - h + 3, 3, 3, '#7A1E2A');
    }

    function spawn() {
      if (t >= nextSpark) {
        const y = GROUND - 26 - Math.floor(rnd(t) * 3) * 16;
        for (let i = 0; i < 3; i++) sparks.push({ x: WD + i * 16, y });
        nextSpark = t + 34 + Math.floor(rnd(t + 1) * 30);
      }
      if (t >= nextRock) {
        rocks.push({ x: WD, h: 12 + Math.floor(rnd(t + 2) * 3) * 4 });
        nextRock = t + 110 + Math.floor(rnd(t + 3) * 70);
      }
    }

    function step() {
      t++;
      scroll += 2.1;
      spawn();
      sparks.forEach((s) => { s.x -= 2.6; });
      rocks.forEach((r) => { r.x -= 2.6; });
      const y0 = GROUND - 11 * BIT_PIXEL - jumpY();
      sparks = sparks.filter((s) => {
        const hit = s.x < BIT_X + 24 && s.x + 8 > BIT_X && s.y < y0 + 33 && s.y + 8 > y0;
        return !hit && s.x > -12;
      });
      rocks = rocks.filter((r) => r.x > -20);
      if (jump === 0 && rocks.some((r) => r.x - BIT_X > 16 && r.x - BIT_X < 50)) jump = 1;
      if (jump > 0) { jump += 1; if (jump > JUMP_FRAMES) jump = 0; }
    }

    function draw() {
      drawSky();
      drawHills();
      drawGround();
      rocks.forEach((r) => drawRock(r.x, r.h));
      sparks.forEach((s) => drawSpark(s.x, s.y, (t >> 3) % 2));
      drawBit(BIT_X, GROUND - 11 * BIT_PIXEL - jumpY(), (t >> 2) % 2);
    }

    for (let i = 0; i < WARM_UP_STEPS; i++) step();
    draw();

    const button = document.getElementById('game-pause');
    if (reduce || !canObserve) { if (button) button.hidden = true; return; }

    const replay = document.getElementById('replay');
    let inView = false;
    let paused = false;
    let running = false;
    let last = 0;
    let replayAt = 0;

    function loop(now) {
      if (!running) return;
      requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      last = now;
      step();
      draw();
      if (now - replayAt > REPLAY_EVERY_MS) {
        replayAt = now;
        replay.classList.add('on');
        setTimeout(() => replay.classList.remove('on'), REPLAY_SHOWN_MS);
      }
    }

    function sync() {
      const go = inView && !paused;
      if (go && !running) {
        running = true;
        replayAt = performance.now() - REPLAY_EVERY_MS + FIRST_REPLAY_DELAY_MS;
        requestAnimationFrame(loop);
      }
      if (!go) running = false;
    }

    pauseButton(button, (p) => { paused = p; sync(); });
    new IntersectionObserver((es) => { inView = es[0].isIntersecting; sync(); }, { threshold: 0.2 }).observe(cv);
  }

  game();
  makerClip();
})();
