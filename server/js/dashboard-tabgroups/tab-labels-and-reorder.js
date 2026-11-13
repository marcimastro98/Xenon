// A tab's icon and label, and dragging tabs into a new order.
'use strict';

// ── Runtime (browser) ─────────────────────────────────────────────
// Tab icons reuse the palette's canonical per-widget glyphs (via
// DashboardPalette.iconFor) so EVERY widget's tab shows the same icon it was
// added from — no separate, drift-prone copy. Sized by CSS (.tabgroup-tab-ico).
// Unknown atoms fall back to text only.
function _tabIcon(base, mid) {
  // A custom tile shows its package's own glyph when the package ships one
  // (manifest `icon`, built as an inert SVG element by CustomWidget); every
  // other case keeps the palette's glyph, the puzzle for a custom tile.
  const own = (base === 'custom' && window.CustomWidget && typeof window.CustomWidget.assignedIcon === 'function')
    ? window.CustomWidget.assignedIcon(mid) : null;
  const svg = own ? null : (window.DashboardPalette && window.DashboardPalette.iconFor)
    ? window.DashboardPalette.iconFor(base) : null;
  if (!own && !svg) return null;
  const span = document.createElement('span');
  span.className = 'tabgroup-tab-ico';
  if (own) span.appendChild(own);
  else span.innerHTML = svg;   // static, trusted SVG from the palette icon map
  return span;
}

// Label a tab for a member. A custom-widget host ('custom') carries the generic
// type name; swap in the assigned package's real name (e.g. "Keyring") when one
// is known. The name is an untrusted package field, so it goes through
// textContent, and its data-i18n key is cleared so applyTranslations can't
// overwrite it back to "Custom widget".
function _applyMemberLabel(label, base, mid) {
  let custom = '';
  if (base === 'custom' && window.CustomWidget
      && typeof window.CustomWidget.assignedName === 'function') {
    custom = window.CustomWidget.assignedName(mid) || '';
  }
  if (custom) {
    label.removeAttribute('data-i18n');
    label.textContent = custom;
  } else {
    label.setAttribute('data-i18n', 'layout_widget_' + base);
    label.textContent = t('layout_widget_' + base);
  }
}

// Re-label existing custom tabs once the SDK package list loads (names aren't
// available on the first layout pass during a cold reload). Cheap: touches only
// the label text of already-rendered tabs, never relocates member atoms.
function _refreshGroupLabels() {
  document.querySelectorAll('.tabgroup-tab').forEach(tab => {
    if (tab.dataset.base !== 'custom') return;
    const label = tab.querySelector('.tabgroup-tab-label');
    if (label) _applyMemberLabel(label, tab.dataset.base, tab.dataset.member);
    // The package's glyph arrives with the same package list as its name.
    const icon = _tabIcon(tab.dataset.base, tab.dataset.member);
    const old = tab.querySelector('.tabgroup-tab-ico');
    if (icon && old) old.replaceWith(icon);
    else if (icon && label) tab.insertBefore(icon, label);
  });
}

// ── Tab reorder (edit mode) ───────────────────────────────────────
// Drag a tab sideways along its bar to reorder the group's tabs; the resulting
// order IS `group.members`, so it is saved with the layout and survives reloads
// and other surfaces. Pointer events, not HTML5 drag-and-drop (which never fires
// on the touchscreen), with a small movement threshold so a plain tap still
// switches tab. The button itself is moved in the DOM as it crosses a
// neighbour's midpoint — what the user sees during the drag is the drop result.
const TAB_DRAG_THRESHOLD_PX = 6;

function _commitTabOrder(bar) {
  const tile = bar.closest('.tabgroup');
  const gid = tile && tile.dataset.groupId;   // read live: a tile can be re-used
  if (!gid) return;
  const layout = getDashboardLayout();
  const order = Array.from(bar.querySelectorAll(':scope > .tabgroup-tab')).map(t => t.dataset.member);
  if (!reorderMembers(layout, gid, order)) return;
  saveDashboardLayout(layout, { status: false });
}

// Bound once per bar (the bar element survives every renderGroupTile pass, which
// only replaces its children), so tabs need no per-tab listener.
function _bindTabReorder(bar) {
  if (bar.dataset.reorderBound === '1') return;
  bar.dataset.reorderBound = '1';
  let drag = null;
  let justDragged = null;   // the tab whose trailing click must not switch tab

  const release = () => {
    if (!drag) return null;
    const d = drag;
    drag = null;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    d.tab.style.transform = '';
    d.tab.classList.remove('is-dragging');
    bar.classList.remove('is-reordering');
    return d;
  };

  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    // A layout re-render (a save from another surface, a widget added elsewhere)
    // rebuilds the bar's children mid-drag: the tab we hold is no longer in it,
    // so abandon the gesture rather than re-inserting a discarded node.
    if (drag.tab.parentElement !== bar) { release(); return; }
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.startX) < TAB_DRAG_THRESHOLD_PX) return;
      drag.active = true;
      drag.tab.classList.add('is-dragging');
      bar.classList.add('is-reordering');
    }
    drag.tab.style.transform = '';   // measure the slot, not the offset drawn last move
    const ref = Array.from(bar.querySelectorAll(':scope > .tabgroup-tab')).find(el => {
      if (el === drag.tab) return false;
      const r = el.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2;
    }) || null;
    if (ref !== drag.tab.nextElementSibling) bar.insertBefore(drag.tab, ref);
    // Follow the finger inside the bar so the pill reads as picked up, not as a
    // slot that snaps only once a midpoint is crossed.
    const rect = drag.tab.getBoundingClientRect();
    drag.tab.style.transform = 'translateX(' + (e.clientX - rect.left - drag.grabOffsetX) + 'px)';
  };

  const onUp = (e) => {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    const d = release();
    if (!d || !d.active) return;
    // The pointerup that ends a drag still produces a click on that tab; that
    // click must not also switch the active tab.
    justDragged = d.tab;
    setTimeout(() => { if (justDragged === d.tab) justDragged = null; }, 400);
    _commitTabOrder(bar);
  };

  bar.addEventListener('pointerdown', (e) => {
    if (drag || e.button > 0) return;
    if (!document.body.classList.contains('layout-editing')) return;
    const tab = e.target.closest && e.target.closest('.tabgroup-tab');
    if (!tab || tab.parentElement !== bar) return;
    if (e.target.closest('.tabgroup-remove')) return;
    if (bar.querySelectorAll(':scope > .tabgroup-tab').length < 2) return;
    drag = {
      tab, pointerId: e.pointerId, startX: e.clientX, active: false,
      grabOffsetX: e.clientX - tab.getBoundingClientRect().left,
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });

  bar.addEventListener('click', (e) => {
    if (!justDragged || !e.target.closest || e.target.closest('.tabgroup-tab') !== justDragged) return;
    justDragged = null;
    e.stopPropagation();   // capture phase: beats the tab's own click handler
    e.preventDefault();
  }, true);
}
