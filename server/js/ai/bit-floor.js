'use strict';
// Bit at the foot of every chat pane (the tile, its copies, the phone's
// full-screen chat): the live Bit at the start of the composer, and above it a
// bubble with what Bit says. The bubble holds one line (the hello of an empty
// chat, a few words as a turn starts, an answer when poked) and the chat's
// status (the dots, the steps of a long turn), which moves in here.
// ai-bit-chat.js mounts the Bit and turns its mood; this file builds the places,
// speaks, and tells the page when a chat on screen lies under the corner Bit,
// which then steps aside (BitCompanion.css): two Bits one over the other read
// as a glitch. Anywhere else the corner Bit stays, egg included.
(() => {
  const POKE_MS = 4500; // a poke's line, then back to the line underneath
  const POKE_GAP_MS = 700; // taps closer than this are one poke
  const END_SLACK_PX = 32; // a log scrolled this close to its end counts as at the end
  // A pane shorter than this keeps the bubble to the turn's status: a line on top
  // would leave the log no room (a phone's chat tile is about 180px).
  const TIGHT_PANE_PX = 300;
  // setAiStatus() states that start a turn -> the moment Bit says a line for.
  const TURN_LINE = { thinking: 'thinking', connecting: 'thinking', working: 'working' };

  const said = { kept: '', turn: '', poke: '' }; // poke over turn over kept
  let pokeTimer = 0;
  let pokedAt = 0;
  let lastStatus = '';
  let seen = null;
  let sized = null;
  const onScreen = new Set();

  const panes = () => document.querySelectorAll('[data-chatf="pane"]');

  function el(tag, cls) {
    const n = document.createElement(tag);
    n.className = cls;
    return n;
  }

  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  // The corner keeps its box while it steps aside (visibility), so it is measured the same either way.
  function tellCorner() {
    onScreen.forEach((h) => { if (!h.isConnected) onScreen.delete(h); }); // a copy's tile went away
    const corner = document.querySelector('.bitc');
    const at = corner && onScreen.size ? corner.getBoundingClientRect() : null;
    const under = !!at && at.width > 0 && [...onScreen].some((h) => {
      const pane = h.closest('[data-chatf="pane"]');
      return !!pane && overlaps(at, pane.getBoundingClientRect());
    });
    document.body.classList.toggle('bit-chat-under-corner', under);
  }

  // The chats on screen, so the corner knows when one lies under it.
  function watch(host) {
    if (typeof IntersectionObserver !== 'function') return;
    seen ||= new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) onScreen.add(e.target);
        else onScreen.delete(e.target);
      }
      tellCorner();
    });
    seen.observe(host);
  }

  // Measured on the pane, never the log: the bubble's own size cannot flip it back.
  function fit(pane) {
    const h = pane.clientHeight;
    pane.classList.toggle('bit-say-tight', h > 0 && h < TIGHT_PANE_PX);
  }

  function watchSize(pane) {
    if (typeof ResizeObserver !== 'function') return;
    sized ||= new ResizeObserver((entries) => { for (const e of entries) fit(e.target); });
    sized.observe(pane);
  }

  function floorBit() {
    const host = el('span', 'bit-floor-bit');
    host.dataset.chatf = 'bit';
    host.setAttribute('aria-hidden', 'true'); // a toy: the chat works the same without it
    watch(host);
    return host;
  }

  function sayRow() {
    const row = el('div', 'bit-say');
    row.dataset.chatf = 'say';
    const bubble = el('div', 'bit-say-bubble');
    bubble.append(el('p', 'bit-say-line'));
    row.append(bubble);
    return row;
  }

  // Every log scrolled to its end stays there when the bubble under it grows.
  function keepEnds(change) {
    const ends = [...document.querySelectorAll('[data-chatf="pane"] .ai-chat')]
      .filter((log) => log.clientHeight && log.scrollHeight - log.scrollTop - log.clientHeight < END_SLACK_PX);
    change();
    if (ends.length) requestAnimationFrame(() => ends.forEach((log) => { log.scrollTop = log.scrollHeight; }));
  }

  function paint() {
    const line = said.poke || said.turn || said.kept;
    keepEnds(() => document.querySelectorAll('[data-chatf="say"] .bit-say-line').forEach((p) => {
      if (p.textContent !== line) p.textContent = line;
    }));
  }

  /** Builds what a pane lacks: Bit in its composer, the bubble above, the status inside it. */
  function ensure() {
    panes().forEach((pane) => {
      const row = pane.querySelector('.ai-input-row');
      if (!row) return;
      if (!row.querySelector('.bit-floor-bit')) {
        row.prepend(floorBit());
        watchSize(pane);
      }
      fit(pane);
      const say = pane.querySelector(':scope > .bit-say') || pane.insertBefore(sayRow(), pane.querySelector(':scope > .ai-attach-preview') || row);
      const bubble = say.querySelector(':scope > .bit-say-bubble');
      const status = pane.querySelector('#ai-status, [data-chatf="mirror-status"]');
      if (status && status.parentElement !== bubble) bubble.append(status);
    });
    tellCorner();
    paint();
  }

  /** The line that stays until changed: the hello of an empty chat ('' clears it). */
  function hold(text) {
    said.kept = String(text || '');
    paint();
  }

  /** A line for a few seconds, over whatever Bit was saying. */
  function say(text) {
    clearTimeout(pokeTimer);
    said.poke = String(text || '');
    pokeTimer = setTimeout(() => { said.poke = ''; paint(); }, POKE_MS);
    paint();
  }

  /** The chat's status changed (setAiStatus through BitChat): a turn starting gets a line of its own. */
  function status(state) {
    const next = state || '';
    if (next === lastStatus) return;
    lastStatus = next;
    const moment = TURN_LINE[next];
    said.turn = moment && window.BitApp ? BitApp.say(moment) : '';
    if (!moment) said.poke = '';
    paint();
  }

  function poke(host) {
    const now = Date.now();
    if (now - pokedAt < POKE_GAP_MS) return;
    pokedAt = now;
    window.BitApp?.playerFor(host)?.poke();
    if (window.BitApp) say(BitApp.say('poke'));
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const host = e.target?.closest?.('.bit-floor-bit');
      if (host) poke(host);
    });
    if (typeof addEventListener === 'function') {
      addEventListener('resize', tellCorner, { passive: true });
    }
  }

  window.BitFloor = { ensure, hold, say, status };
})();
