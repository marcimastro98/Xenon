'use strict';
// The purchase sheet's decisions, apart from the page so they can be tested
// without one: the colours a Store entry lends it, what its catalog text becomes,
// and what is on screen for each moment of a sale. js/buy-sheet.js draws the result.
(function (root) {
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  // The Store's own defaults for an entry without a full preview (catColors).
  const FALLBACK = { accent: '#1ed760', bg: '#0a0f0d', text: '#e9f2ee' };
  const NEUTRALS = ['#000000', '#ffffff'];
  const READABLE = 4.5; // WCAG AA for text on the paper
  const VISIBLE = 2;    // the accent still reads as a shape on the paper
  const LINE_MAX = 160;
  const NAME_MAX = 80;
  const KIND_MAX = 40;
  // Store shots made by the launch kit keep a margin around the screen.
  const SHOT_W = 1280;
  const SHOT_H = 680;
  const SHOT_ZOOM = 1.12;
  // A picture this far from the 2:1 frame would lose too much to a crop: it is
  // shown whole instead. 16:10 and 16:9 shots still fill the frame.
  const FILL_MIN = 1.6;
  const FILL_MAX = 2.6;
  // Longest headline that fits a phone at the big size.
  const DONE_BIG_MAX = 7;

  function hex(value) {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!HEX.test(v)) return '';
    return v.length === 4 ? '#' + [...v.slice(1)].map((c) => c + c).join('') : v;
  }

  function luminance(color) {
    const n = parseInt(color.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  const bestOn = (fill, options) => options.reduce((top, c) => (contrast(c, fill) > contrast(top, fill) ? c : top));

  // The sheet wears the entry's paper and ink; the button takes its accent unless
  // that would vanish into the paper, with whichever label reads best on it.
  function palette(preview) {
    const p = preview && typeof preview === 'object' ? preview : {};
    const paper = hex(p.bg) || FALLBACK.bg;
    const given = hex(p.text) || FALLBACK.text;
    const ink = contrast(given, paper) >= READABLE ? given : bestOn(paper, NEUTRALS);
    const accent = hex(p.accent) || FALLBACK.accent;
    const mark = contrast(accent, paper) >= VISIBLE ? accent : ink;
    return { paper, ink, mark, markInk: bestOn(mark, [ink, paper, ...NEUTRALS]) };
  }

  const squeeze = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');

  // The opening sentence of a description, cut at a word when it runs long.
  function firstSentence(text) {
    const s = squeeze(text);
    const found = s.match(/^.*?(?:[.!?](?=\s|$)|[。！？])/);
    const first = found ? found[0] : s;
    if (first.length <= LINE_MAX) return first;
    const cut = first.slice(0, LINE_MAX);
    const space = cut.lastIndexOf(' ');
    return (space > LINE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '') + '…';
  }

  const artZoom = (w, h) => (w === SHOT_W && h === SHOT_H ? SHOT_ZOOM : 1);
  const artFit = (w, h) => (w > 0 && h > 0 && (w / h < FILL_MIN || w / h > FILL_MAX) ? 'contain' : 'cover');

  // Catalog data enters here: plain text with a size limit, https pictures only.
  function card(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      name: squeeze(r.name).slice(0, NAME_MAX),
      kind: squeeze(r.kind).slice(0, KIND_MAX),
      line: firstSentence(r.line),
      art: (Array.isArray(r.art) ? r.art : []).filter((u) => typeof u === 'string' && /^https:\/\//i.test(u)),
      colors: palette(r.preview),
    };
  }

  // "{n} Sparks" as the number and the word beside it, drawn at two sizes.
  function priceParts(template, n) {
    return { n: String(n), unit: String(template).replace('{n}', '').trim() };
  }

  const usd = (cents) => (cents / 100).toFixed(2) + ' USD';
  const doneIsLong = (text) => [...String(text)].length > DONE_BIG_MAX;

  /**
   * What is on screen for one moment of the sale.
   * @param {object} s known (the local reads are in), selling, opens, member, canPay,
   *   typing, typed (the code in the field), sparksOnly, price, chosen ("buy just this
   *   one" was pressed), bought, held (whole Sparks, null when unknown)
   */
  function decide(s) {
    const kind = String(s.typed || '').slice(0, 2);
    const typedPays = kind === 'XC' || kind === 'XS';
    const typedItem = kind === 'XL';
    let view = 'code';
    if (s.bought) view = 'done';
    else if (s.opens && !s.typing) view = 'opens';
    else if (s.selling) view = !s.sparksOnly && !s.chosen && !s.typing ? 'pass' : 'offer';
    const done = view === 'done';
    const counted = Number.isInteger(s.held) && !typedItem;
    const below = counted && s.held < s.price;
    const short = !typedItem && (below || (!!s.known && !s.canPay && !typedPays));
    let line = null;
    if (below) line = 'short';
    else if (counted && !short) line = 'left';
    return {
      view,
      short,
      line,
      gets: !short,
      tick: !short && !typedItem,
      buy: !short && !typedItem,
      more: short,
      joinAlt: short && !s.member && !!s.known,
      seller: view === 'offer' && !typedItem,
      have: view === 'pass',
      other: !done && !s.typing && (!!s.sparksOnly || view === 'opens'),
      back: !done && (!!s.typing || (!s.sparksOnly && !!s.chosen)),
      code: !done && !!s.typing,
      slot: done || view === 'opens' ? 'act' : s.typing ? 'code' : null,
    };
  }

  root.BuySheetModel = { palette, contrast, firstSentence, artZoom, artFit, card, priceParts, usd, doneIsLong, decide };
})(typeof window !== 'undefined' ? window : globalThis);
