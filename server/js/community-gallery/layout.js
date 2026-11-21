// How the Store is laid out: the order of the kinds, how many cards a shelf and a page hold, how
// wide a picture may be, and which entries lead it.
'use strict';

(() => {
  // Kind display order for the grouped ("browse all") view.
  const KIND_ORDER = ['widget', 'bundle', 'theme', 'bg', 'ambient', 'deck', 'page', 'icons', 'sounds', 'topbar'];
  // Rows of the rail that a tag set at review fills: what is handy on the screen by itself, not
  // only in a dashboard, and widgets made for the screen on an AIO pump (manifest `pump`).
  const TAG_VIEWS = [
    { id: '__screen', tag: 'on-screen', key: 'gallery_for_screen', fallback: 'For the screen', icon: 'topbar' },
    { id: '__pump', tag: 'pump-screen', key: 'gallery_for_pump', fallback: 'For pump screens', icon: 'pump' },
  ];
  const hasTag = (tag) => (e) => Array.isArray(e?.tags) && e.tags.includes(tag);
  // The tag row the Store is on, with its entries; null on any other view.
  function taggedView(all, activeKind) {
    const view = TAG_VIEWS.find((v) => v.id === activeKind);
    return view ? { view, list: all.filter(hasTag(view.tag)) } : null;
  }
  const PAGE = 24;             // load-more page size for lists
  const SHELF_MAX = 12;        // cards on a shelf before "See all"
  const SEE_ALL_FROM = 5;      // fewer than this fit on the shelf itself
  const WIDE_SHOT = 2.1;       // a picture wider than this cannot be shown whole on a card
  // Most of the catalog's pictures are the whole of a wide screen and a card shows less
  // than half of one. A look fills the screen around its middle; a widget or a pack
  // starts on the left, where its name and its numbers are.
  const CENTRED_KINDS = new Set(['theme', 'bg', 'ambient']);

  const JUST_ADDED_MAX = 8;    // default cap for the "Just added" block
  const KIND_SHELF_MIN = 3;    // a kind with fewer shares the "More" shelf
  const INSTALLS_WAIT_MS = 500; // how long a first paint waits for the install counts

  // Same shape as the ratings aggregates above: batched, TTL-cached by the local
  // server, painted into slots once they land.
  //
  // The number is what dashboards REPORTED, not how many people own the thing:
  // reporting is a setting, a reinstall counts again, and nothing identifies the
  // sender (that is the point — see server/store-catalog/community-installs.js). So it is
  // labelled "installs" and never "owners" or "downloads", and the tooltip says
  // what it actually counts. Below MIN_SHOWN it stays blank rather than telling a
  // creator their work has four installs, which is noise either way.
  const MIN_INSTALLS_SHOWN = 10;

  // Chosen in the hub admin (entry.featured), not inferred from catalog order:
  // 'main' is the full-width hero, every other featured entry rides in the
  // column beside it, capped so the top of the Store stays one screenful.
  // Entries past the cap are not lost — they keep their normal place in the
  // sections below, exactly as if they had not been featured.
  const SPOT_SIDE_MAX = 3;

  function isFeatured(entry) { return !!entry && (entry.featured === 'main' || entry.featured === 'on'); }

  window.CommunityGalleryLayout = {
    KIND_ORDER, TAG_VIEWS, hasTag, taggedView, PAGE, SHELF_MAX, SEE_ALL_FROM, WIDE_SHOT,
    CENTRED_KINDS, JUST_ADDED_MAX, KIND_SHELF_MIN, INSTALLS_WAIT_MS, MIN_INSTALLS_SHOWN,
    SPOT_SIDE_MAX, isFeatured,
  };
})();
