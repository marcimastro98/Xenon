'use strict';
// Which dashboard page "go to page X" means: its id, its place in the row of
// pages ("2"), "next"/"prev", or words from the name the user sees (accents
// and case ignored). Shared by the server (Bit's go_to_page checks the name
// before the dashboard moves) and the pager (the dashboard does the move).
(function () {
  const STEPS = Object.freeze({ next: 1, prev: -1, previous: -1 });
  const NAME_MIN = 3; // shorter words match too many names

  const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

  // pages: [{ id, label }] in the order the user sees them.
  // → { id } | { step: 1|-1 } | { index } (a place the caller resolves) | null
  function findPageTarget(target, pages) {
    const raw = String(target == null ? '' : target).trim().slice(0, 64);
    if (!raw) return null;
    const list = (Array.isArray(pages) ? pages : []).filter(p => p && p.id);
    const exact = list.find(p => p.id === raw);
    if (exact) return { id: exact.id };
    const w = fold(raw);
    if (STEPS[w]) return { step: STEPS[w] };
    if (/^\d{1,2}$/.test(w)) return Number(w) >= 1 ? { index: Number(w) - 1 } : null;
    const name = (p) => fold(p.label || p.id);
    const hit = list.find(p => name(p) === w || fold(p.id) === w)
      || (w.length >= NAME_MIN ? list.find(p => name(p).includes(w)) : null);
    return hit ? { id: hit.id } : null;
  }

  // What Bit is told when no page answers to `target` (null = one does), so it
  // names the real pages instead of saying "done".
  function pageTargetMiss(target, pages) {
    const list = (Array.isArray(pages) ? pages : []).filter(p => p && p.id);
    const hit = findPageTarget(target, list);
    if (hit && (hit.id || hit.step || hit.index < list.length)) return null;
    return { ok: false, error: 'not_found', pages: list.map(p => p.label || p.id) };
  }

  const api = { findPageTarget, pageTargetMiss };
  if (typeof window !== 'undefined') window.PageTarget = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
