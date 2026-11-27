'use strict';
// The tabs over the rail of the Bit's room (bit-companion/wardrobe.js): all the items, its own, then
// how the others come (the supporters', the shop's for Sparks, the free ones), then each place on the
// body that has something. Each tab is a picture over its word: a hanger for all of them, the Bit as
// it stands for its own, the Store's heart for the supporters', the Spark for the shop, a parcel for
// the free ones, the Bit wearing one item of that place for the others (what it wears there, else
// what it owns, else the first on the list). Each way in has its own mark and colour on its tab and
// under its cards, so a glance says what an item costs. The supporters' items show elsewhere only
// once owned. A wide rail lays the tabs in even rows. A way-in tab opens with what its items are.
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HANGER = ['.....##......', '....#..#.....', '.......#.....', '......#......', '....##.##....', '..##.....##..', '##.........##', '#############'];
  const HEART = ['.##...##.', '####.####', '#########', '#########', '.#######.', '..#####..', '...###...', '....#....'];
  const PARCEL = ['..##.##..', '...#.#...', '#########', '#...#...#', '#########', '.#..#..#.', '.#..#..#.', '.#######.'];
  const SPARK = ['....#....', '....#....', '...###...', '#########', '...###...', '....#....', '....#....'];
  const WHOLE = [-3, -5, 18, 16]; // the Bit from its hat to the floor
  // How an item comes, in the order of the tabs: the ones to pay for first, as a shop shows them.
  const WAYS = ['supporter', 'shop', 'free'];
  const WAY_WORD = { supporter: 'mybit_group_supporter', shop: 'mybit_group_shop', free: 'mybit_tab_free' };

  /** @param {{ source: string }} it @returns {'supporter'|'shop'|'free'} traits, seasons and the founders' are free */
  const wayOf = (it) => (it.source === 'supporter' || it.source === 'shop' ? it.source : 'free');

  // A pixel glyph in the text's colour, centred in the same 17x16 box as the Bit's pictures.
  function glyph(rows) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `${-(17 - rows[0].length) / 2} ${-(16 - rows.length) / 2} 17 16`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    rows.forEach((row, y) => { [...row].forEach((c, x) => {
      if (c !== '#') return;
      const r = document.createElementNS(SVG_NS, 'rect');
      for (const [k, v] of [['x', x], ['y', y], ['width', 1], ['height', 1], ['fill', 'currentColor']]) r.setAttribute(k, String(v));
      svg.append(r);
    }); });
    return svg;
  }

  // A move draws nothing on Bit: its picture is its own bits, three of them flying off up and
  // right, the Bit's colours as the text's colour.
  function moveArt(it) {
    const svg = glyph(['']);
    svg.setAttribute('viewBox', '0 0 17 16');
    [[1, 9, 1], [6, 5, 0.75], [11, 1, 0.5]].forEach(([ox, oy, o]) => {
      for (const part of it.layers) for (const [x, y, w = 1, h = 1] of part.cells) {
        const r = document.createElementNS(SVG_NS, 'rect');
        const fill = /^#[0-9a-f]{6}$/i.test(part.fill) ? part.fill : 'currentColor';
        for (const [k, v] of [['x', ox + x], ['y', oy + y], ['width', w], ['height', h], ['fill', fill], ['fill-opacity', o]]) r.setAttribute(k, String(v));
        svg.append(r);
      }
    });
    return svg;
  }

  // The mark of a way in: the Spark as the Store draws it, the others in pixels.
  function mark(way) {
    const spark = way === 'shop' && typeof window.XenonCredits?.spark === 'function' ? window.XenonCredits.spark({ still: true }) : null;
    return spark?.namespaceURI === SVG_NS ? spark : glyph(way === 'supporter' ? HEART : way === 'shop' ? SPARK : PARCEL);
  }

  /** A free item's tag under its card: the parcel, then what brings it (its season, its trait). */
  function freeTag(text, cls = '') {
    const tag = makeEl('span', `broom-tag is-free ${cls}`.trim());
    tag.append(mark('free'), makeEl('span', '', text));
    return tag;
  }

  /**
   * Whether a tab holds an item: the supporters' tab only theirs, which elsewhere show once owned.
   * @param {string} id the tab
   * @param {{ it: { source: string, slot: string }, owned: boolean }} e
   */
  function holds(id, e) {
    if (WAYS.includes(id)) return wayOf(e.it) === id;
    if (id === 'mine') return e.owned;
    if (!e.owned && e.it.source === 'supporter') return false;
    return id === 'all' || e.it.slot === id;
  }

  /**
   * The tabs with something in them, each with the item its picture shows.
   * @param {{ it: { id: string, slot: string }, owned: boolean }[]} entries the rail's items, its own first
   * @param {{ worn?: string[] }} bit the server's view of the Bit
   * @param {{ PLACES: string[] }} W the engine's wardrobe
   * @param {(key: string) => string} say
   * @returns {{ id: string, word: string, item: object|null }[]}
   */
  function list(entries, bit, W, say) {
    const tabs = [{ id: 'all', word: say('mybit_tab_all'), item: null }];
    if (entries.some((e) => e.owned)) tabs.push({ id: 'mine', word: say('mybit_mine'), item: null });
    for (const way of WAYS) if (entries.some((e) => holds(way, e))) tabs.push({ id: way, word: say(WAY_WORD[way]), item: null });
    const worn = new Set(Array.isArray(bit.worn) ? bit.worn : []);
    for (const slot of W.PLACES) {
      const here = entries.filter((e) => holds(slot, e));
      if (here.length) tabs.push({ id: slot, word: say(`mybit_slot_${slot}`), item: (here.find((e) => worn.has(e.it.id)) || here[0]).it });
    }
    return tabs;
  }

  // Even rows on a wide rail, at most four tabs across so a word like "Sostenitori" stays whole.
  const columnsOf = (n) => Math.ceil(n / Math.ceil(n / 4));

  function picture(tab, bit, art) {
    if (tab.item) return art.thumb(bit, tab.item);
    if (tab.id === 'mine') return art.figure(window.BitApp?.dressed(bit.worn) || null, WHOLE);
    return WAYS.includes(tab.id) ? mark(tab.id) : glyph(HANGER);
  }

  /**
   * The row of tabs; `pick` runs on a tap, after the tapped one is pressed.
   * @param {{ id: string, word: string, item: object|null }[]} tabs from `list`
   * @param {object} bit
   * @param {{ current: string, label: string, signal: AbortSignal, pick: (id: string) => void,
   *   art: { thumb: (bit: object, it: object) => SVGElement, figure: (look: object|null, box: number[]) => SVGElement } }} o
   */
  function row(tabs, bit, o) {
    const box = makeEl('div', 'broom-tabs');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', o.label);
    box.style.setProperty('--broom-tab-cols', String(columnsOf(tabs.length)));
    for (const tab of tabs) {
      const b = makeEl('button', WAYS.includes(tab.id) ? `broom-tab is-${tab.id}` : 'broom-tab');
      b.type = 'button';
      b.dataset.tab = tab.id;
      b.setAttribute('aria-pressed', String(tab.id === o.current));
      const art = makeEl('span', 'broom-tab-art');
      art.append(picture(tab, bit, o.art));
      b.append(art, makeEl('span', 'broom-tab-word', tab.word));
      b.addEventListener('click', () => {
        for (const other of box.children) other.setAttribute('aria-pressed', String(other === b));
        o.pick(tab.id);
      }, { signal: o.signal });
      box.append(b);
    }
    return box;
  }

  /**
   * A way-in tab opens with what its items are; the supporters' one offers the pass when this PC has
   * none (a paired phone never: the pass is used on the PC). Null for the other tabs.
   * @param {string} id the tab
   * @param {{ say: (key: string) => string, signal: AbortSignal }} ctx
   */
  function intro(id, ctx) {
    if (!WAYS.includes(id)) return null;
    const note = makeEl('p', `broom-intro is-${id}`);
    const head = makeEl('span', 'broom-intro-head');
    head.append(mark(id), makeEl('span', '', ctx.say(WAY_WORD[id])));
    note.append(head, makeEl('span', '', ctx.say(`mybit_group_${id}_line`)));
    const join = id === 'supporter' && !window.RemoteSurface?.isRemote?.() ? window.BitKeep?.join?.(ctx) : null;
    if (join) {
      Promise.resolve(window.XenonCredits?.supporterSaved?.() ?? false).then((saved) => {
        if (!saved && !ctx.signal.aborted) note.append(join);
      }, () => {});
    }
    return note;
  }

  window.BitTabs = { list, row, holds, intro, freeTag, wayOf, moveArt };
})();
