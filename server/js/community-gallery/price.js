// What an entry costs or where it stands, in a few words: the card's price line, the supporter tier
// mark with its Sparks price, the meter of a numbered drop, and the facts on its page.
'use strict';

window.CommunityGalleryPrice = (wrapper) => {
  const { entryInstallState, dropUnavailable, dropSoldOut, sparksOnly, icon, installsText } = wrapper;

  const { t, el, limitedLeftText, sparksPriceText } = window.CommunityGalleryWords;

  function limitedMeter(entry) {
    const { total, left } = limitedStock(entry.limited);
    const meter = el('div', 'cst-meter');
    const bar = el('div', 'cst-meter-bar'); const fill = el('div', 'cst-meter-fill');
    fill.style.width = Math.round(((total - left) / total) * 100) + '%'; bar.appendChild(fill); meter.appendChild(bar);
    meter.appendChild(el('span', 'cst-meter-left', limitedLeftText(entry)));
    return meter;
  }

  function detailFacts(entry) {
    const facts = el('dl', 'cst-facts');
    const fact = (label, value) => {
      const row = el('div', 'cst-fact');
      row.appendChild(el('dt', null, label)); row.appendChild(value);
      facts.appendChild(row);
    };
    if (entry.version) fact(t('gallery_fact_version', 'Version'), el('dd', null, entry.version));
    const installs = el('dd', 'cgal-installs', installsText(entry.id));
    installs.dataset.id = entry.id;
    fact(t('gallery_fact_installs', 'Installs'), installs);
    if (entry.category) fact(t('gallery_fact_category', 'Category'), el('dd', null, t('gallery_cat_' + entry.category.replace('-', '_'), entry.category)));
    return facts;
  }

  // What an entry costs or where it stands, in a few words, for the card's line.
  function priceInto(node, entry, quiet) {
    const state = entryInstallState(entry);
    const says = (text) => { node.textContent = text; };
    if (state === 'current') return says(t('gallery_installed', 'Installed'));
    if (state === 'update') return says(t('gallery_update', 'Update…').replace(/\s*(…|\.\.\.)$/, ''));
    if (entry.needsNewerApp) return says(t('gallery_requires_version', 'Requires Xenon') + ' v' + entry.appVersionMin);
    if (entry.limited) {
      if (dropUnavailable(entry)) return says(dropSoldOut(entry) ? t('gallery_limited_soldout', 'Sold out') : t('gallery_limited_closed', 'Claims closed'));
      return says(limitedLeftText(entry));
    }
    if (sparksOnly(entry)) {
      if (window.XenonCredits) node.appendChild(window.XenonCredits.spark({ still: true }));
      node.appendChild(document.createTextNode(String(entry.sparks)));
      return undefined;
    }
    if (entry.locked || entry.supportersOnly) return quiet ? undefined : says(t('gallery_locked_badge', 'Supporters'));
    return says(t('gallery_price_free', 'Free'));
  }

  // The supporter-tier mark; a Sparks-only drop shows its price instead.
  // A drop also sold for Sparks names that second way in next to the first.
  function lockedTierInto(node, entry, label, withUsd) {
    if (sparksOnly(entry) && window.XenonCredits) {
      node.appendChild(window.XenonCredits.offerMark());
      node.appendChild(el('span', null, sparksPriceText(entry.sparks, withUsd)));
      return;
    }
    node.appendChild(icon('supporters'));
    node.appendChild(el('span', null, label));
    if (!entry.limited && entry.sparks > 0) {
      node.appendChild(el('span', null, t('gallery_or_sparks', 'or {price}').replace('{price}', sparksPriceText(entry.sparks, withUsd))));
    }
  }

  return { limitedMeter, detailFacts, priceInto, lockedTierInto };
};
