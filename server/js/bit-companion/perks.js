'use strict';
// The Bit's extras the hub may keep for supporters (server/bit/perks.js), as the page shows them:
// a closed one carries the gold heart where it is chosen (room-panels.js, pocket.js), and choosing
// it anyway, which the server refuses with { error: 'locked', perk }, opens it: with a pass saved on
// this PC the hub is asked (POST /api/bit/perk), then the choice is made again; without one, or when
// the hub says no, the support sheet opens, counted as this extra's (`bit-allscreens`...). Never a
// notice or a sign: only where the person was choosing it. A paired phone never uses the pass.
// Loaded with the signs (companion.js loadSigns).
(() => {
  const SOURCES = Object.freeze({ allScreens: 'bit-allscreens', moreKeys: 'bit-morekeys' });
  const FREE_KEYS = 4;
  const MAX_KEYS = 8; // server/bit/pocket.js
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The Store's supporter heart (community-gallery.js, wardrobe-keep.js): this file also loads where the room does not.
  const HEART = 'M12 20.4l-1.5-1.3C5.7 14.9 3 12.4 3 9.3A4.3 4.3 0 0 1 7.3 5c1.5 0 3 .8 3.7 2 .7-1.2 2.2-2 3.7-2A4.3 4.3 0 0 1 21 9.3c0 3.1-2.7 5.6-7.5 9.8z';
  let asking = false;

  const perks = () => window.BitApp?.state()?.perks || {};
  /** Closed to this Bit: the hub keeps it for supporters and it was never opened here. */
  const locked = (id) => perks()[id]?.open === false;

  /** The gold heart on the control that chooses a closed extra; nothing on an open one. */
  function mark(el, id) {
    if (!el || !locked(id)) return;
    const svg = document.createElementNS(SVG_NS, 'svg');
    const path = document.createElementNS(SVG_NS, 'path');
    for (const [key, v] of [['viewBox', '0 0 24 24'], ['aria-hidden', 'true'], ['class', 'bit-perk-heart']]) svg.setAttribute(key, v);
    path.setAttribute('d', HEART);
    svg.append(path);
    el.classList.add('is-perk');
    el.append(svg);
    el.setAttribute('aria-description', String(t('mybit_perk_supporters')));
  }

  async function ask(id) {
    const r = await fetch(SERVER + '/api/bit/perk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ perk: id }),
    }).then((res) => res.json()).catch(() => ({ ok: false, error: 'network' }));
    if (r?.bit) window.BitApp?.heard(r.bit);
    return r;
  }

  /** The server said 'locked': open the extra, then `again()` makes the choice once more. */
  async function offer(id, again) {
    if (!SOURCES[id] || asking) return;
    asking = true;
    try {
      const saved = !window.RemoteSurface?.isRemote?.() && await (window.XenonCredits?.supporterSaved?.() ?? false);
      const r = saved ? await ask(id) : null;
      if (r?.ok) { again?.(); return; }
      if (r?.error === 'network') { window.XenonToast?.show({ type: 'error', message: t('mybit_save_failed') }); return; }
      window.SupportSheet?.open(SOURCES[id]);
    } finally {
      asking = false;
    }
  }

  window.BitPerks = Object.freeze({
    locked, mark, offer,
    /** How many quick keys the pocket may hold now (server/bit/pocket.js). */
    keys: () => (locked('moreKeys') ? FREE_KEYS : MAX_KEYS),
  });
})();
