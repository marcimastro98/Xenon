;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.storefront = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* The storefront layout — what the Store shows, in what order, in what shape.
   *
   * It rides inside catalog.json as a `layout` key, written by the hub admin,
   * and is read by BOTH storefronts: the website catalog and the in-app Store.
   * Before this, the order of the page was hard-coded identically in two
   * renderers, so a limited drop and a supporter pack landed in the same
   * spotlight with equal visual weight and nothing could be moved without a
   * deploy.
   *
   * THIS FILE IS THE CONTRACT. `docs/catalog/index.html` (a deliberately
   * self-contained page) and the hub's `src/storefront-layout.js` (a separate
   * repo) carry mirrored copies; when you change the shape here, change them in
   * the same session or the two storefronts drift apart again — which is the
   * exact bug this replaced.
   *
   * Fail-safe by construction: an absent, malformed or empty layout returns
   * DEFAULT_BLOCKS, which reproduces the previous fixed order exactly. A live
   * public catalog must never render blank because someone saved a bad value.
   */

  // Every block type the storefronts know how to draw. A type outside this list
  // is dropped rather than guessed at.
  const BLOCK_TYPES = ['spotlight', 'limited', 'supporters', 'new', 'kinds', 'archive'];

  /* What each block draws. This is the RENDERERS' vocabulary, not a menu: a
   * block has exactly one form until a storefront actually learns to draw a
   * second one. It shipped as a three-way choice per block and none of the
   * alternatives did anything — `form` is read in exactly one place
   * (shouldAutoplay, below), so "big card, full width" rendered the same big
   * card and "grid" rendered the same scrolling rail with the auto-scroll
   * switched off. An option that changes nothing is worse than an absent one:
   * it makes the whole panel untrustworthy, because you cannot tell which of the
   * other switches are real either.
   *
   * The admin builds its controls from these lists, so a single value simply has
   * no dropdown. To add a real alternative: teach BOTH storefronts to draw it,
   * then list it here and the control appears on its own.
   */
  const FORMS = {
    spotlight: ['hero-column'],
    limited: ['carousel', 'grid'],
    supporters: ['rail', 'grid'],
    new: ['grid'],
    kinds: ['grid'],
    archive: ['rail-quiet', 'grid'],
  };

  // Where a block's entries come from. Same rule: one value unless the choice
  // genuinely changes what is drawn. The spotlight's was a two-way pick nothing
  // read — it always shows the featured entries and falls back to its automatic
  // ladder when none is set, whichever value was stored. `limited` is the one
  // real choice: whether finished drops come back onto the shelf.
  const SOURCES = {
    spotlight: ['manual'],
    limited: ['auto-live', 'auto-all'],
    supporters: ['auto'],
    new: ['auto'],
    kinds: ['auto'],
    archive: ['auto'],
  };

  // The order the storefronts used before the layout existed. Kept as the
  // fallback so an absent layout is not a behaviour change.
  const DEFAULT_BLOCKS = [
    { type: 'spotlight', on: true, form: 'hero-column', source: 'manual', autoplayOver: 0, max: 0 },
    { type: 'limited', on: true, form: 'carousel', source: 'auto-live', autoplayOver: 0, max: 0 },
    { type: 'supporters', on: true, form: 'rail', source: 'auto', autoplayOver: 2, max: 0 },
    { type: 'new', on: false, form: 'grid', source: 'auto', autoplayOver: 0, max: 0 },
    { type: 'kinds', on: true, form: 'grid', source: 'auto', autoplayOver: 0, max: 0 },
    { type: 'archive', on: true, form: 'rail-quiet', source: 'auto', autoplayOver: 0, max: 0 },
  ];

  const clampInt = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  };

  function normalizeBlock(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const type = typeof raw.type === 'string' ? raw.type : '';
    if (BLOCK_TYPES.indexOf(type) < 0) return null;
    const forms = FORMS[type];
    const sources = SOURCES[type];
    return {
      type,
      // Absent `on` means shown: a block added by a newer admin must not be
      // invisible on an older storefront.
      on: raw.on !== false,
      form: forms.indexOf(raw.form) >= 0 ? raw.form : forms[0],
      source: sources.indexOf(raw.source) >= 0 ? raw.source : sources[0],
      // 0 disables autoplay entirely; the storefronts only animate a rail when
      // it holds MORE than this many cards.
      autoplayOver: clampInt(raw.autoplayOver, 0, 50, type === 'supporters' ? 2 : 0),
      // 0 means "no cap".
      max: clampInt(raw.max, 0, 60, 0),
    };
  }

  /* Normalize whatever the catalog carries into a list the renderers can walk
   * without a single further check. Duplicated types collapse to the first
   * (two spotlights would render an entry twice and duplicate its DOM id), and
   * any known type the document omits is appended in its default state, off if
   * it defaults to off — so a layout written before a block existed keeps
   * working and simply does not show the new one until the admin enables it.
   */
  function normalizeLayout(raw) {
    const list = (raw && typeof raw === 'object' && Array.isArray(raw.blocks)) ? raw.blocks : null;
    if (!list) return DEFAULT_BLOCKS.map((b) => ({ ...b }));

    const out = [];
    const seen = Object.create(null);
    for (const item of list.slice(0, 40)) {
      const b = normalizeBlock(item);
      if (!b || seen[b.type]) continue;
      seen[b.type] = true;
      out.push(b);
    }
    if (!out.length) return DEFAULT_BLOCKS.map((b) => ({ ...b }));
    for (const d of DEFAULT_BLOCKS) if (!seen[d.type]) out.push({ ...d, on: false });
    return out;
  }

  // Read the layout off a catalog document, whatever shape it is in.
  function layoutOf(catalog) {
    if (!catalog || typeof catalog !== 'object') return normalizeLayout(null);
    return normalizeLayout(catalog.layout);
  }

  // Should a rail of `count` cards animate itself? Motion on an always-on
  // display is a cost, so it is opt-in by size and never overrides the user's
  // reduced-motion setting (the caller checks that).
  function shouldAutoplay(block, count) {
    if (!block || block.on === false) return false;
    if (block.form !== 'carousel' && block.form !== 'rail') return false;
    const over = Number(block.autoplayOver) || 0;
    return over > 0 && Number(count) > over;
  }

  /* Split the limited tier between its own shelf and the Archive.
   *
   * Shared because getting it wrong puts ONE entry in TWO sections, which
   * duplicates its DOM id, double-counts it, and breaks the deep link to it —
   * and because the three cases are not obvious enough to be re-derived per
   * renderer (they already disagreed once). `soldOut` is a predicate so each
   * caller can decide with the freshest stock it has: the storefronts read the
   * hub-hydrated count, the hub admin reads D1 directly.
   */
  function splitLimited(items, blocks, soldOut) {
    const list = Array.isArray(items) ? items : [];
    const isOut = typeof soldOut === 'function' ? soldOut : () => false;
    const layout = normalizeLayout({ blocks });
    const lim = layout.find((b) => b.type === 'limited');
    const arch = layout.find((b) => b.type === 'archive');
    // 'auto-all' is the shelf asking for the finished drops back. That and the
    // Archive holding them are the same claim made twice, so the shelf wins and
    // the Archive has nothing left to hold.
    if (lim && lim.source === 'auto-all') return { shelf: list.slice(), archive: [] };
    if (arch && arch.on) return { shelf: list.filter((e) => !isOut(e)), archive: list.filter(isOut) };
    // Archive off: the rule from before the layout existed. A finished drop keeps
    // its place on the shelf only when nothing in the tier can still be claimed,
    // so the section never vanishes and the tier keeps being explained — and a
    // claimable drop never sits next to one nobody can get.
    const anyClaimable = list.some((e) => !isOut(e));
    return { shelf: list.filter((e) => !(anyClaimable && isOut(e))), archive: [] };
  }

  return {
    BLOCK_TYPES, FORMS, SOURCES, DEFAULT_BLOCKS,
    normalizeBlock, normalizeLayout, layoutOf, shouldAutoplay, splitLimited,
  };
});
