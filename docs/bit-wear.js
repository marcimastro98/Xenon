// docs/bit-wear.js: the wardrobe on the Bit page (bit.html#wardrobe). Three made-up Bits, one
// for each way an item comes (supporters, shop, free), each trying on that way's items in turn
// while the section is on screen, and holding still under reduced motion. The supporters' items
// come from the hub (GET /bit/items, the list the app reads); until it answers that Bit wears none.
// Needs /create/bit-kit.js first. The pictures are <img> of an SVG the engine wrote, never markup.
(() => {
  'use strict';
  const X = globalThis.Xenon;
  const HUB = 'https://xenon-supporter-hub.xenonedge.workers.dev';
  const TIMEOUT_MS = 10000;
  const STEP_MS = 2600;
  const SIZE = 240;
  const GROUND = '#15191c'; // the pictures' own ground (.bitp-way-pic)
  // Invented seeds, so the three look nothing alike and are nobody's Bit.
  const SEEDS = { supporter: 'a7d2096be15c3f40', shop: '3f9a1c07e2b45d68', free: 'd8e3f1726a0c95b4' };

  const pics = [...document.querySelectorAll('.bitp-way-pic[data-way]')].filter((el) => SEEDS[el.dataset.way]);
  if (!pics.length || !X || !X.bit || !X.bitGenome || !X.bitLook || !X.bitWardrobe || !X.bitPlayer) return;
  const W = X.bitWardrobe;
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** What each way offers: the supporters' items the hub lists (up to next month's), the shop's on sale, the free ones.
   *  A move is left out: it is how Bit teleports, nothing a still picture can show. */
  function offered() {
    const on = (it) => it.offered !== false && it.slot !== 'move';
    return {
      supporter: W.ITEMS.filter((it) => it.source === 'supporter' && on(it)),
      shop: W.ITEMS.filter((it) => it.source === 'shop' && on(it)),
      free: W.ITEMS.filter((it) => (it.source === 'trait' || it.source === 'season') && it.slot !== 'move'),
    };
  }

  const shots = new Map(); // `${way}:${item id}` -> data URI, drawn once
  function shot(way, it) {
    const key = way + ':' + (it ? it.id : '');
    if (!shots.has(key)) {
      const look = X.bitLook.lookOf(X.bitGenome.decode(SEEDS[way]), { worn: it ? W.outfit([it.id]) : [], background: GROUND });
      const clip = X.bit.clip('pose') || X.bit.clip('idle');
      // home: a house shows behind Bit, as in its room (it is drawn only while Bit sleeps elsewhere).
      const svg = X.bit.frameSvg(clip, X.bitPlayer.stillIndex(clip), { size: SIZE, look, home: true, clipId: 'bitw' + shots.size });
      shots.set(key, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
    }
    return shots.get(key);
  }

  let lists = offered();
  let turn = 0;
  const imgs = pics.map((pic) => {
    const img = new Image(SIZE, SIZE);
    img.alt = '';
    img.decoding = 'async';
    pic.replaceChildren(img);
    return img;
  });

  function paint() {
    pics.forEach((pic, i) => {
      const list = lists[pic.dataset.way];
      const it = list.length ? list[turn % list.length] : null;
      try { imgs[i].src = shot(pic.dataset.way, it); } catch { /* an item the engine cannot draw: keep the last picture */ }
    });
  }

  // Turn only while the section is on screen and the tab is in front.
  let timer = 0;
  let inView = false;
  function run() {
    const go = inView && !still && document.visibilityState === 'visible';
    if (go && !timer) timer = setInterval(() => { turn += 1; paint(); }, STEP_MS);
    if (!go && timer) { clearInterval(timer); timer = 0; }
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((seen) => { inView = seen.some((e) => e.isIntersecting); run(); }).observe(pics[0].closest('.bitp-ways') || pics[0]);
  }
  document.addEventListener('visibilitychange', run);

  async function hubItems() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(HUB + '/bit/items', { credentials: 'omit', signal: ctl.signal });
      const body = await res.json().catch(() => null);
      return body && body.ok === true && Array.isArray(body.items) ? body.items : [];
    } catch { return []; } finally { clearTimeout(t); }
  }

  paint();
  // W.addItems checks every item the hub sends, as the app does; what fails is left out.
  hubItems().then((items) => {
    if (!items.length) return;
    W.addItems(items);
    lists = offered();
    paint();
  });
})();
