'use strict';

// Bit on the search bar's button. It reacts to what happens and otherwise stays
// quiet: it listens while you type, gets an idea when nothing is found, waves when
// you reach for it, hops when pressed, says hello when the bar opens. One clip per
// event at most, never one per key, and everything stops under the same holds as
// any other live Bit. Without the engine the button shows a plain chat icon.

(function () {
  const GREETINGS = ['hello', 'wave', 'peek', 'wink'];
  const LISTEN_MS = 1600;
  const WAVE_EVERY_MS = 3000;
  const PRESS_MS = 160;
  const GREET_DELAY_MS = 120;
  const CHAT_ICON = 'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-4.6 3.7A.9.9 0 0 1 3 20V5a1 1 0 0 1 1-1Z';

  let greetTurn = 0;

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  function chatIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', CHAT_ICON);
    svg.appendChild(path);
    return svg;
  }

  const QUIET = {
    typing() {},
    noResults() {},
    wave() {},
    press: () => Promise.resolve(),
    greet() {},
    stop() {},
  };

  function mountBit(face, onOverlay) {
    const app = window.BitApp;
    if (!app) return null;
    // A Bit on the search overlay is not held by the freeze that overlay asks for.
    const hold = onOverlay ? app.TILE_HOLD.filter((name) => name !== 'overlay-frozen') : undefined;
    return app.mount(face, { mood: 'idle', fidgets: true, calm: true, hold });
  }

  /**
   * @param {HTMLButtonElement} button named by its caller: this Bit stays decorative
   * @param {{ onOverlay?: boolean }} [opts]
   */
  function create(button, opts = {}) {
    const face = document.createElement('span');
    face.className = 'spot-bit-face';
    button.appendChild(face);
    const player = mountBit(face, !!opts.onOverlay);
    if (!player) {
      button.classList.add('is-plain');
      face.appendChild(chatIcon());
      return QUIET;
    }

    let listenTimer = null;
    let greetTimer = null;
    let lastWave = 0;
    let ideaFor = null;

    return {
      typing() {
        clearTimeout(listenTimer);
        player.setMood('listen');
        listenTimer = setTimeout(() => player.setMood('idle'), LISTEN_MS);
      },
      // One idea per phrase: the same empty search asked again stays quiet.
      noResults(phrase) {
        if (phrase === ideaFor) return;
        ideaFor = phrase;
        void player.play('idea');
      },
      wave() {
        const now = Date.now();
        if (now - lastWave < WAVE_EVERY_MS) return;
        lastWave = now;
        void player.play('wave');
      },
      // Long enough to see the hop start before the chat covers it.
      press() {
        void player.play('hop');
        if (reducedMotion()) return Promise.resolve();
        return new Promise((resolve) => { setTimeout(resolve, PRESS_MS); });
      },
      // Two callers can say the bar opened: the last one wins, one greeting.
      greet() {
        clearTimeout(greetTimer);
        greetTimer = setTimeout(() => {
          void player.play(GREETINGS[greetTurn++ % GREETINGS.length]);
        }, GREET_DELAY_MS);
      },
      stop() {
        clearTimeout(listenTimer);
        clearTimeout(greetTimer);
        ideaFor = null;
        player.setMood('idle');
      },
    };
  }

  window.SpotlightBit = { create };
})();
