'use strict';
// The tabs over the rail of the Bit's room (bit-companion/wardrobe.js): all the items, its own, then
// each place on the body that has something. Each tab is a picture over its word, drawn on this Bit:
// a hanger for all of them, the Bit as it stands for its own, the Bit wearing one item of that place
// for the others (what it wears there, else what it owns, else the first on the list). So the tabs
// read at a glance and every Bit's tabs are its own. A wide rail lays them in two even rows.
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HANGER = ['.....##......', '....#..#.....', '.......#.....', '......#......', '....##.##....', '..##.....##..', '##.........##', '#############'];
  const WHOLE = [-3, -5, 18, 16]; // the Bit from its hat to the floor

  function hanger() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '-2 -4 17 16');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    HANGER.forEach((row, y) => { [...row].forEach((c, x) => {
      if (c !== '#') return;
      const r = document.createElementNS(SVG_NS, 'rect');
      for (const [k, v] of [['x', x], ['y', y], ['width', 1], ['height', 1], ['fill', 'currentColor']]) r.setAttribute(k, String(v));
      svg.append(r);
    }); });
    return svg;
  }

  /**
   * The tabs with something in them, each with the item its picture shows.
   * @param {{ it: { id: string, slot: string }, owned: boolean }[]} entries the rail's items, its own first
   * @param {{ worn?: string[] }} bit the server's view of the Bit
   * @param {{ SLOTS: string[] }} W the engine's wardrobe
   * @param {(key: string) => string} say
   * @returns {{ id: string, word: string, item: object|null }[]}
   */
  function list(entries, bit, W, say) {
    const tabs = [{ id: 'all', word: say('mybit_tab_all'), item: null }];
    if (entries.some((e) => e.owned)) tabs.push({ id: 'mine', word: say('mybit_mine'), item: null });
    const worn = new Set(Array.isArray(bit.worn) ? bit.worn : []);
    for (const slot of W.SLOTS) {
      const here = entries.filter((e) => e.it.slot === slot);
      if (here.length) tabs.push({ id: slot, word: say(`mybit_slot_${slot}`), item: (here.find((e) => worn.has(e.it.id)) || here[0]).it });
    }
    return tabs;
  }

  // Two even rows on a wide rail; four tabs or fewer stay in one.
  const columnsOf = (n) => (n <= 4 ? n : Math.ceil(n / 2));

  function picture(tab, bit, art) {
    if (tab.item) return art.thumb(bit, tab.item);
    if (tab.id === 'mine') return art.figure(window.BitApp?.dressed(bit.worn) || null, WHOLE);
    return hanger();
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
      const b = makeEl('button', 'broom-tab');
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

  window.BitTabs = { list, row };
})();
