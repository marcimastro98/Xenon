// The Store's shelves: a named row of cards with its previous and next keys and its way to the
// whole list, and the spotlight block that sets the hero beside the other featured entries.
'use strict';

window.CommunityGalleryShelves = (wrapper) => {
  const { heroBanner, renderCard, icon, goView } = wrapper;

  const { t, el } = window.CommunityGalleryWords;
  const { SEE_ALL_FROM } = window.CommunityGalleryLayout;

  // The hero and, beside it, the other featured entries as small cards. Alone it
  // keeps the whole width.
  function spotlightBlock(main, side) {
    const wrap = el('div', 'cst-spot' + (side.length ? '' : ' is-solo'));
    wrap.appendChild(heroBanner(main));
    if (side.length) {
      const col = el('div', 'cst-side');
      side.forEach((entry) => { const c = renderCard(entry); c.classList.add('cst-side-item'); col.appendChild(c); });
      wrap.appendChild(col);
    }
    return wrap;
  }

  // ── Shelves ────────────────────────────────────────────────────────────────
  // Previous and next keys appear only when the row has more than it shows.
  function shelfKeys(row) {
    const keys = el('div', 'cst-keys');
    const key = (name, dir) => {
      const b = el('button', 'cst-step'); b.type = 'button'; b.appendChild(icon(name));
      b.title = t(dir < 0 ? 'gallery_row_back' : 'gallery_row_next', dir < 0 ? 'Back' : 'Next');
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        row.scrollBy({ left: dir * row.clientWidth, behavior: calm ? 'auto' : 'smooth' });
      });
      keys.appendChild(b);
      return b;
    };
    const prev = key('back', -1), next = key('next', 1);
    row._cstSync = () => {
      const room = row.scrollWidth - row.clientWidth;
      keys.hidden = room <= 1;
      prev.disabled = row.scrollLeft <= 1;
      next.disabled = row.scrollLeft >= room - 1;
    };
    row.addEventListener('scroll', row._cstSync, { passive: true });
    requestAnimationFrame(row._cstSync);
    return keys;
  }

  // A named shelf. opts.more is the view "See all" leads to, opts.lead one line
  // under the name, opts.quiet a shelf that is history rather than stock, and
  // opts.grid the layout's form 'grid': every card at once, not a row. opts.card
  // draws each item instead of the plain card. opts.seeAll keeps the way to the
  // whole list on a short shelf that does not hold all of it.
  function shelf(titleText, items, opts) {
    const o = opts || {};
    const wrap = el('section', 'cst-shelf' + (o.history ? ' is-history' : ''));
    const draw = o.card || ((e) => renderCard(e, { quiet: o.quiet }));
    const head = el('div', 'cst-shelf-head');
    head.appendChild(el('h2', null, titleText));
    const row = el('div', o.grid ? 'cst-grid' : 'cst-row');
    items.forEach((e) => row.appendChild(draw(e)));
    if (!o.grid) head.appendChild(shelfKeys(row));
    if (o.more && (o.seeAll || items.length >= SEE_ALL_FROM)) {
      const all = el('button', 'cst-more', t('gallery_seeall', 'See all').replace(/\s*→\s*$/, ''));
      all.type = 'button';
      all.addEventListener('click', () => goView(o.more));
      head.appendChild(all);
    }
    wrap.appendChild(head);
    if (o.lead) wrap.appendChild(el('p', 'cst-shelf-lead', o.lead));
    wrap.appendChild(row);
    return wrap;
  }

  return { spotlightBlock, shelf };
};
