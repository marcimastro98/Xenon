// The count on the Settings gear and on the buttons that open the Store: owned items with an update
// first, else catalog entries this PC has never seen in the Store.
'use strict';

window.CommunityGalleryStoreDot = (wrapper) => {
  const { api, findUpdates } = wrapper;

  const { t, el } = window.CommunityGalleryWords;
  const { readSeenIds } = window.CommunityGallerySeen;

  // Count catalog entries this device has never seen in the Store — for the count
  // on the Settings gear and the "Open the Store" buttons. Read-only: it never
  // touches the seen set (browsing the Store is what marks entries seen), and
  // returns 0 when the Store was never opened, so nothing is flagged before the
  // first browse (#5).
  async function newSinceLastVisit() {
    const seen = readSeenIds();
    if (!seen) return 0;   // never browsed the Store yet → nothing to advertise
    try {
      const out = await api('/api/community/catalog');
      if (!out || !out.ok || !Array.isArray(out.entries)) return 0;
      return out.entries.filter((e) => e && e.id && !seen.has(e.id)).length;
    } catch { return 0; }
  }

  // Number of OWNED catalog items with an update available — the red badge on the
  // Store buttons and the Installed tab. Standalone (works while the Store is
  // closed): findUpdates() re-reads the install index and joins it against the
  // catalog exactly like the Store's own "Aggiornamenti" section, so the three
  // never disagree.
  async function countUpdates() {
    try {
      const out = await api('/api/community/catalog');
      if (!out || !out.ok || !Array.isArray(out.entries)) return 0;
      const ups = await findUpdates(out.entries);
      return Array.isArray(ups) ? ups.length : 0;
    } catch { return 0; }
  }

  // Paint (or clear) the badge on the Settings entry points to the Store. UPDATES
  // win — a red count of owned items with a newer version, the actionable "open
  // the Store and update" signal. With none pending it falls back to the accent
  // "N new since your last visit" discovery count (#5). Refreshed at boot, when the
  // Store closes, and whenever an install/update lands.
  function refreshStoreDot() {
    // The Settings entry points to the Store, plus the topbar Settings gear —
    // the gear is what you see WITHOUT opening anything, so the count reaches
    // you on the dashboard itself and clears once the Store is opened.
    const btns = document.querySelectorAll('.settings-nav-store, .settings-store-open, .qbtn-settings');
    if (!btns.length) return;
    Promise.all([countUpdates(), newSinceLastVisit()]).then(([updates, fresh]) => {
      const n = updates > 0 ? updates : fresh;
      const isUpdate = updates > 0;
      btns.forEach((btn) => {
        let dot = btn.querySelector('.cgal-store-dot');
        if (n > 0) {
          if (!dot) { dot = el('span', 'cgal-store-dot'); btn.appendChild(dot); }
          dot.textContent = n > 99 ? '99+' : String(n);
          dot.classList.toggle('is-new', !isUpdate);   // accent for "new", red for updates
          dot.title = isUpdate ? t('gallery_updates', 'Updates') : t('gallery_new_filter', 'New');
        } else if (dot) { dot.remove(); }
      });
    }).catch(() => { /* best-effort — no dot is fine */ });
  }

  return { countUpdates, refreshStoreDot };
};
