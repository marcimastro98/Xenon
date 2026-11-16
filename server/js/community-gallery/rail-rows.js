// A row of the Store's rail that opens its view, and the red count of available updates on the
// Installed row.
'use strict';

window.CommunityGalleryRailRows = (wrapper) => {
  const { goView, countUpdates } = wrapper;

  const { el, shortCount } = window.CommunityGalleryWords;

  function railRow(id, label, mark, count) {
    const row = el('button', 'cst-railrow'); row.type = 'button'; row.dataset.view = id;
    row.appendChild(mark);
    row.appendChild(el('span', 'cst-railrow-name', label));
    row.appendChild(el('b', 'cst-railrow-count', count || ''));
    row.addEventListener('click', () => goView(id));
    return row;
  }

  // Red count of available updates on Installed: you open it to update. Async
  // (findUpdates joins the catalog against the install index); refreshed on open
  // and whenever an install/update lands (via refreshInstalledBadge).
  function paintInstalledRow(row) {
    countUpdates().then((n) => {
      const count = row.querySelector('.cst-railrow-count');
      count.textContent = n > 0 ? shortCount(n) : '';
      count.classList.toggle('is-update', n > 0);
    }).catch(() => { /* best-effort — no count is fine */ });
  }

  return { railRow, paintInstalledRow };
};
