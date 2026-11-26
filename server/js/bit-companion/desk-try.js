'use strict';
// Bit's desktop try-on: what is tried on in the room, the Bit on the desktop wears for ten minutes
// (desk.js draws it in look()), then takes off. The next room opens with it still tried on, so its
// keep bar is there: that bar, in the room, stays the only offer (never a sign or a notice).
// Loaded with desk.js, only where the shell draws the desktop Bit (companion.js loadDesk).
(() => {
  const TRY_MS = 10 * 60 * 1000;
  const MAX_IDS = 6; // one per place on the body
  let trial = null;  // { ids, until } while it lasts
  let timer = 0;
  let left = [];     // what had its ten minutes, for the next room (once)
  let lastIds = [];  // what was tried last: its keep bar's support link says it came from here

  const app = () => window.BitApp;
  const tell = () => dispatchEvent(new CustomEvent('xenon-bit-desk-try'));

  function end() {
    clearTimeout(timer);
    timer = 0;
    if (!trial) return;
    left = trial.ids;
    trial = null;
    tell();
  }

  function start(ids) {
    clearTimeout(timer);
    trial = { ids: ids.slice(0, MAX_IDS), until: Date.now() + TRY_MS };
    lastIds = trial.ids;
    timer = setTimeout(end, TRY_MS);
    app()?.seen?.('tryon');
    tell();
    window.BitDesk?.play?.('twirl');
  }

  /** The look of the desktop Bit while something is tried on, or null. */
  function look() {
    if (!trial || Date.now() >= trial.until) return null;
    const worn = app()?.state?.()?.worn;
    return app()?.dressed?.([...(Array.isArray(worn) ? worn : []), ...trial.ids]) || null;
  }

  /** The keep bar's "Try it on the desktop", while the desktop Bit is out; null otherwise. */
  function button(items, ctx) {
    if (!window.BitDesk?.on?.()) return null;
    const ids = items.map((it) => it.id);
    const wearing = () => !!trial && ids.every((id) => trial.ids.includes(id));
    const b = makeEl('button', 'broom-btn', ctx.say(wearing() ? 'mybit_try_desk_on' : 'mybit_try_desk'));
    b.type = 'button';
    b.disabled = wearing();
    b.addEventListener('click', () => {
      start(ids);
      b.textContent = ctx.say('mybit_try_desk_on');
      b.disabled = true;
    }, { signal: ctx.signal });
    return b;
  }

  window.BitDeskTry = Object.freeze({
    look, button, start,
    /** Ended early: what it tried was kept, or taken off. */
    stop: end,
    /** What had its ten minutes on the desktop, once: the next room tries it on again. */
    take: () => { const ids = left; left = []; return ids; },
    /** Whether this item was the last tried on the desktop. */
    tried: (id) => lastIds.includes(id),
  });
})();
