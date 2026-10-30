'use strict';

// One set of global listeners closes any open dropdown on an outside click,
// Escape, scroll or resize — installed once, so re-initialising selects (e.g.
// the Deck editor re-renders) never leaks a listener per instance.
let _csGlobalArmed = false;
function _csCloseAll() {
  document.querySelectorAll('.cs-wrap.cs-open').forEach(w => {
    if (typeof w._csClose === 'function') w._csClose();
  });
}
function _csArmGlobal() {
  if (_csGlobalArmed) return;
  _csGlobalArmed = true;
  document.addEventListener('click', _csCloseAll, { passive: true });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') _csCloseAll(); });
  window.addEventListener('resize', _csCloseAll, { passive: true });
  // capture: catch scrolls inside any container (modals, panels), not just window.
  // But ignore scrolls that happen *inside* an open panel — a long, scrollable
  // option list must not close itself when the user scrolls through it.
  window.addEventListener('scroll', (e) => {
    const tgt = e.target;
    if (tgt && tgt.closest && tgt.closest('.cs-panel')) return;
    _csCloseAll();
  }, { passive: true, capture: true });
}

// Search text compared without case or accents, so "registra" finds "Registrà"
// and "ecran" finds "Écran".
function _csFold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Every word typed must appear somewhere in the option's text, its extra
// keywords or its group's name, in any order: "obs scena" and "scena obs" both
// find "OBS: change scene".
function _csMatches(parts, needle) {
  const words = _csFold(needle).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = _csFold(parts.filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}

// The label as text nodes with each typed word marked where it appears in it.
// Built from text nodes only (never markup), so a label can never inject HTML.
function _csHighlight(label, needle) {
  const frag = document.createDocumentFragment();
  const words = _csFold(needle).split(/\s+/).filter(Boolean);
  const folded = _csFold(label);
  // Folding can change the length (ligatures); then plain text, unmarked.
  if (!words.length || folded.length !== label.length) { frag.appendChild(document.createTextNode(label)); return frag; }
  const marks = new Array(label.length).fill(false);
  words.forEach((w) => {
    const at = folded.indexOf(w);
    if (at >= 0) for (let i = at; i < at + w.length; i++) marks[i] = true;
  });
  let i = 0;
  while (i < label.length) {
    let j = i;
    while (j < label.length && marks[j] === marks[i]) j++;
    const piece = label.slice(i, j);
    if (marks[i]) { const m = document.createElement('mark'); m.className = 'cs-hit'; m.textContent = piece; frag.appendChild(m); }
    else frag.appendChild(document.createTextNode(piece));
    i = j;
  }
  return frag;
}

/**
 * Replaces a native <select> with a styled custom dropdown.
 * The original <select> stays hidden in the DOM — all existing
 * .value reads and onchange handlers continue to work unchanged.
 *
 * Add `data-cs-fixed` to the <select> to position the dropdown panel with
 * `position: fixed` (anchored to the trigger, clamped to the viewport, flips
 * up when there's no room) — needed when the select lives inside a scrollable
 * container that would otherwise clip an absolutely-positioned panel.
 *
 * Long lists (opt-in, all on the <select> unless noted):
 * - `data-cs-search` (+ `data-cs-search-placeholder`, `data-cs-empty`): a
 *   search box; arrow keys move through the results, Enter picks one.
 * - `data-cs-collapsible`: each <optgroup> opens and closes; the one holding
 *   the choice starts open. On an <optgroup>: `data-cs-key` (stable id),
 *   `data-cs-icon`, `data-cs-open` (starts open), `data-cs-search-skip`
 *   (left out of search results, for groups that repeat other options).
 * - On an <option>: `data-cs-icon` (trusted SVG), `data-cs-keywords` (extra
 *   words the search matches), `data-cs-note` (second line in the list).
 *
 * @param {HTMLSelectElement} selectEl
 */
function initCustomSelect(selectEl) {
  if (!selectEl || selectEl.dataset.csInit) return;
  selectEl.dataset.csInit = '1';
  // When this control came into existence. Compared against the timestamp of a
  // click to tell a click aimed AT it from a click that merely landed on it —
  // see the trigger handler for the gesture that produces the second kind.
  const bornAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  selectEl.hidden = true;

  // ── Build wrapper ──────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = 'cs-wrap';
  selectEl.insertAdjacentElement('beforebegin', wrap);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cs-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const labelEl = document.createElement('span');
  labelEl.className = 'cs-label';

  const chevron = document.createElement('span');
  chevron.className = 'cs-chevron';
  chevron.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5.5 8,10.5 13,5.5"/></svg>';

  trigger.appendChild(labelEl);
  trigger.appendChild(chevron);

  const panel = document.createElement('ul');
  panel.className = 'cs-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;

  wrap.appendChild(trigger);
  wrap.appendChild(panel);

  // ── Helpers ────────────────────────────────────────────────

  function selectedOption() {
    return Array.from(selectEl.options).find(o => o.value === selectEl.value) || null;
  }

  // The trigger shows the chosen option's icon too, when it has one, so a long
  // list of look-alike names (the Deck's actions) reads at a glance when closed.
  let triggerIco = null;
  function syncLabel() {
    const opt = selectedOption();
    labelEl.textContent = opt ? opt.textContent.trim() : '';
    const icon = opt && opt.dataset ? opt.dataset.csIcon : '';
    if (icon) {
      if (!triggerIco) {
        triggerIco = document.createElement('span');
        triggerIco.className = 'cs-trigger-ico';
        trigger.insertBefore(triggerIco, labelEl);
      }
      triggerIco.innerHTML = icon;
      triggerIco.hidden = false;
    } else if (triggerIco) {
      triggerIco.hidden = true;
    }
  }

  const hasSearch = selectEl.hasAttribute('data-cs-search');
  // Opt-in (data-cs-collapsible): each <optgroup> is a header that opens and
  // closes its options, so a long categorised list starts as a short list of
  // categories. Searching shows every match whatever is open.
  const collapsible = selectEl.hasAttribute('data-cs-collapsible');
  let openGroups = null;
  const groupKey = (g) => g.getAttribute('data-cs-key') || g.label || '';
  function initOpenGroups() {
    openGroups = new Set();
    Array.from(selectEl.children).forEach((g) => {
      if (g.tagName !== 'OPTGROUP') return;
      const holdsChoice = selectEl.value !== '' && Array.from(g.children).some((o) => o.value === selectEl.value);
      if (holdsChoice || g.hasAttribute('data-cs-open')) openGroups.add(groupKey(g));
    });
  }

  const enabledRows = () => Array.from(panel.querySelectorAll('.cs-option:not(.cs-option-disabled)'));
  function setActive(li) {
    panel.querySelectorAll('.cs-option.cs-active').forEach((n) => n.classList.remove('cs-active'));
    if (!li) return;
    li.classList.add('cs-active');
    revealRows(li, li);
  }
  function moveActive(step) {
    const rows = enabledRows();
    if (!rows.length) return;
    const at = rows.findIndex((n) => n.classList.contains('cs-active'));
    const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + step));
    setActive(rows[next]);
  }

  // Scrolls the panel (never the page) so rows first..last are in view, the
  // first one winning when both cannot fit; the sticky search row is not "view".
  function revealRows(first, last) {
    if (panel.scrollHeight <= panel.clientHeight) return;
    const sticky = panel.querySelector('.cs-search-wrap');
    const stickyH = sticky ? sticky.offsetHeight : 0;
    let top = panel.scrollTop;
    const bottom = last.offsetTop + last.offsetHeight + 6 - panel.clientHeight;
    if (bottom > top) top = bottom;
    if (first.offsetTop - stickyH < top) top = first.offsetTop - stickyH;
    panel.scrollTop = Math.max(0, top);
  }

  function renderOptions(filterText = '') {
    panel.textContent = '';
    const needle = filterText.trim();
    const searching = needle !== '';
    if (collapsible && !openGroups) initOpenGroups();

    // Opt-in in-panel search box (data-cs-search) for long lists (e.g. SignalRGB
    // effects). It's a sticky, non-option row that filters the list live; typing
    // re-renders and restores focus + caret so it stays usable across keystrokes.
    // Arrow keys move through the results and Enter picks one, so a name can be
    // typed and chosen without the mouse.
    if (hasSearch) {
      const searchLi = document.createElement('li');
      searchLi.className = 'cs-search-wrap';
      searchLi.setAttribute('role', 'presentation');
      searchLi.addEventListener('click', e => e.stopPropagation());
      const inp = document.createElement('input');
      inp.type = 'search';
      inp.className = 'cs-search-input';
      inp.placeholder = selectEl.getAttribute('data-cs-search-placeholder') || '…';
      inp.setAttribute('aria-label', inp.placeholder);
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      inp.value = filterText;
      inp.addEventListener('input', () => {
        renderOptions(inp.value);
        positionPanel(true);
        const next = panel.querySelector('.cs-search-input');
        if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveActive(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const li = panel.querySelector('.cs-option.cs-active');
          if (li) li.click();
        }
      });
      searchLi.appendChild(inp);
      panel.appendChild(searchLi);
    }

    // One <option> → one row. A row may carry an icon via the option's
    // `data-cs-icon` attribute (a trusted inline SVG string set by the caller).
    // `data-cs-keywords` adds words the search also looks at (another language,
    // a synonym) without showing them.
    const rowMatches = (opt, groupLabel) => _csMatches([opt.textContent, opt.dataset && opt.dataset.csKeywords, groupLabel], needle);
    const addOption = (opt) => {
      const li = document.createElement('li');
      // A disabled <option> renders as a non-selectable hint row (e.g. "configure
      // this service in Settings"): greyed, not clickable, skipped by keyboard nav.
      const disabled = opt.disabled;
      li.className = 'cs-option' + (opt.value === selectEl.value ? ' cs-selected' : '') + (disabled ? ' cs-option-disabled' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(opt.value === selectEl.value));
      if (disabled) li.setAttribute('aria-disabled', 'true');
      li.dataset.value = opt.value;
      if (opt.dataset && opt.dataset.csIcon) {
        const ic = document.createElement('span');
        ic.className = 'cs-option-ico';
        ic.innerHTML = opt.dataset.csIcon;
        li.appendChild(ic);
      }
      const txt = document.createElement('span');
      txt.className = 'cs-option-label';
      if (searching) txt.appendChild(_csHighlight(opt.textContent.trim(), needle));
      else txt.textContent = opt.textContent.trim();
      // Opt-in second line (`data-cs-note`) for options whose name alone doesn't
      // say what they do. It belongs in the open list and NOT in the trigger,
      // which keeps showing the short label — a sentence there stretches the
      // closed control across whatever row it sits in.
      if (opt.dataset && opt.dataset.csNote) {
        const note = document.createElement('span');
        note.className = 'cs-option-note';
        note.textContent = opt.dataset.csNote;
        txt.appendChild(note);
      }
      li.appendChild(txt);
      li.addEventListener('click', e => {
        e.stopPropagation();
        if (disabled) return;          // hint row: keep the panel open, select nothing
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        close();   // panel re-renders fresh (unfiltered) on next open()
      });
      panel.appendChild(li);
    };

    // A collapsible group's header: icon, name, how many it holds, a chevron.
    // A button in the list, so it is reachable by keyboard as well as by touch.
    const addToggleHeader = (node, count, isOpen) => {
      const head = document.createElement('li');
      head.className = 'cs-group cs-group-toggle' + (isOpen ? ' cs-group-open' : '');
      head.setAttribute('role', 'presentation');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cs-group-btn';
      btn.setAttribute('aria-expanded', String(isOpen));
      if (node.dataset && node.dataset.csIcon) {
        const ic = document.createElement('span');
        ic.className = 'cs-group-ico';
        ic.innerHTML = node.dataset.csIcon;
        btn.appendChild(ic);
      }
      const name = document.createElement('span');
      name.className = 'cs-group-name';
      name.textContent = node.label || '';
      btn.appendChild(name);
      if (count > 0) {
        const n = document.createElement('span');
        n.className = 'cs-group-count';
        n.textContent = String(count);
        btn.appendChild(n);
      }
      const chev = document.createElement('span');
      chev.className = 'cs-group-chev';
      chev.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,3.5 10.5,8 6,12.5"/></svg>';
      btn.appendChild(chev);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = groupKey(node);
        const opening = !openGroups.has(key);
        if (opening) openGroups.add(key); else openGroups.delete(key);
        const keep = panel.scrollTop;
        renderOptions('');
        positionPanel(true);
        panel.scrollTop = keep;
        const again = Array.from(panel.querySelectorAll('.cs-group-toggle')).find((h) => h.dataset.key === key);
        if (!again) return;
        if (opening) {
          let last = again;
          while (last.nextElementSibling && last.nextElementSibling.classList.contains('cs-option')) last = last.nextElementSibling;
          revealRows(again, last);
        }
        const b = again.querySelector('.cs-group-btn');
        if (b) b.focus({ preventScroll: true });
      });
      head.dataset.key = groupKey(node);
      head.appendChild(btn);
      panel.appendChild(head);
    };

    // Render <optgroup> as a category header followed by its options; bare
    // <option>s (e.g. a leading "None") render directly.
    let shown = 0;
    Array.from(selectEl.children).forEach(node => {
      if (node.tagName === 'OPTGROUP') {
        // A group that repeats options found elsewhere (e.g. "Recently used")
        // would list every match twice while searching.
        if (searching && node.hasAttribute('data-cs-search-skip')) return;
        const opts = Array.from(node.children).filter(o => o.tagName === 'OPTION');
        const hits = opts.filter((o) => rowMatches(o, node.label));
        // With a filter active, drop a group header whose options all filtered out.
        if (!hits.length) return;
        shown += hits.filter((o) => !o.disabled).length;
        if (collapsible && !searching) {
          const isOpen = openGroups.has(groupKey(node));
          addToggleHeader(node, opts.filter((o) => !o.disabled).length, isOpen);
          if (isOpen) opts.forEach(addOption);
          return;
        }
        const head = document.createElement('li');
        // In a collapsible list the search results keep the same headers, just fixed open.
        head.className = collapsible ? 'cs-group cs-group-static' : 'cs-group';
        head.setAttribute('role', 'presentation');
        if (collapsible && node.dataset && node.dataset.csIcon) {
          const ic = document.createElement('span');
          ic.className = 'cs-group-ico';
          ic.innerHTML = node.dataset.csIcon;
          head.appendChild(ic);
        }
        if (collapsible) {
          const name = document.createElement('span');
          name.className = 'cs-group-name';
          name.textContent = node.label || '';
          head.appendChild(name);
        } else {
          head.appendChild(document.createTextNode(node.label || ''));
        }
        panel.appendChild(head);
        hits.forEach(addOption);
      } else if (node.tagName === 'OPTION' && rowMatches(node, '')) {
        if (!node.disabled) shown++;
        addOption(node);
      }
    });
    if (searching && shown === 0 && selectEl.getAttribute('data-cs-empty')) {
      const empty = document.createElement('li');
      empty.className = 'cs-empty';
      empty.setAttribute('role', 'presentation');
      empty.textContent = selectEl.getAttribute('data-cs-empty');
      panel.appendChild(empty);
    }
    // While searching the first result is the one Enter picks.
    if (searching) setActive(enabledRows()[0] || null);
  }

  // ── Open / close ───────────────────────────────────────────

  const useFixed = selectEl.hasAttribute('data-cs-fixed');

  // Anchor the panel to the trigger with position:fixed so a scrollable/clipping
  // ancestor (e.g. a modal body) can't cut it off. Clamp to the viewport, cap the
  // height to the available space (the panel scrolls when the list is long), and
  // open above the trigger when there's more room there.
  // The box the panel must stay inside, in on-screen coordinates.
  //
  // Normally that is the viewport. Under the Xeneon Edge preview it is NOT: that
  // mode turns <body> into a fixed 2560x720 stage, scales it to fit and hides
  // whatever falls outside it (styles/edge-preview.css). Clamping to the browser
  // window there puts the panel in the letterbox, where `overflow: hidden` cuts
  // it off — reported from the Deck's action picker as "part of the list is
  // outside the window, top of the list is not visible", and measured at 110px
  // of a 50-row menu lost above the stage's top edge.
  function bounds() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const stage = document.documentElement.classList.contains('edge-preview')
      ? document.body : null;
    if (!stage) return { left: 0, top: 0, width: vw, height: vh };
    const r = stage.getBoundingClientRect();
    // Intersected with the window: the stage can be wider than the screen while
    // it is being resized, and half a menu off the right edge is no better.
    const left = Math.max(0, r.left), top = Math.max(0, r.top);
    return {
      left,
      top,
      width: Math.max(0, Math.min(vw, r.right) - left),
      height: Math.max(0, Math.min(vh, r.bottom) - top),
    };
  }

  // Which side the panel opened on. Re-positioning while it is open (a group
  // opened, a search narrowed the list) keeps that side, so the list grows or
  // shrinks in place instead of jumping across the trigger.
  let openedBelow = true;
  // While the panel stays open (typing a search, opening a group) it keeps at
  // least the height it opened with, so the search box never jumps under the
  // finger as the results shrink.
  let openedH = 0;

  function positionPanel(keepSide = false) {
    if (!useFixed) return;
    const r = trigger.getBoundingClientRect();
    const b = bounds();
    const m = 8, gap = 5;
    // Vertical breathing room: keep the panel visibly clear of the top/bottom
    // edges so a long list (e.g. the Deck action picker, ~50 rows) reads as a
    // bounded floating menu instead of a full-height sheet that looks clipped on
    // the very short Xeneon Edge display. Scales with the box, never below m.
    const edge = Math.max(m, Math.round(b.height * 0.07));
    panel.style.position = 'fixed';
    panel.style.margin = '0';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    // A categorised list gets room for its names whatever the trigger's width,
    // and no fixed panel is ever wider than the box it must stay inside.
    panel.style.minWidth = (collapsible ? Math.max(r.width, Math.min(340, b.width - 2 * m)) : r.width) + 'px';
    panel.style.maxWidth = (b.width - 2 * m) + 'px';
    panel.style.maxHeight = 'none';                 // measure the natural height first
    panel.style.minHeight = '';
    // A scaled ancestor (the Edge preview stage) means the panel's LAYOUT pixels
    // and its ON-SCREEN pixels are different units, and every number here mixes
    // the two: the trigger rect and the bounds are on-screen, scrollHeight is
    // layout. Measure the ratio from the panel itself rather than reading the
    // transform, so it holds however the scaling was applied — and so it is
    // exactly 1, and everything below unchanged, when there is none.
    const probe = panel.getBoundingClientRect();
    const scale = panel.offsetHeight > 0 ? (probe.height / panel.offsetHeight) || 1 : 1;
    const natural = panel.scrollHeight * scale;     // on-screen height of the full list
    const spaceBelow = (b.top + b.height) - r.bottom - gap - edge;
    const spaceAbove = r.top - b.top - gap - edge;
    // Drop below unless it doesn't fit and there's more room above.
    // A collapsible list grows when a group opens, so it takes the roomier side
    // from the start rather than the side its closed categories fit on.
    let placeBelow = collapsible
      ? spaceBelow >= spaceAbove || spaceBelow >= 480
      : natural <= spaceBelow || spaceBelow >= spaceAbove;
    if (keepSide) placeBelow = openedBelow;
    openedBelow = placeBelow;
    // Cap the height to the room between the breathing margins so the panel can
    // never spill past (or butt against) the top/bottom edge. The list scrolls
    // when it's taller than the room available.
    const room = collapsible ? Math.max(placeBelow ? spaceBelow : spaceAbove, 160) : b.height - 2 * edge;
    let h = Math.min(natural, room, b.height - 2 * edge);
    if (keepSide && collapsible) h = Math.max(h, Math.min(openedH, room, b.height - 2 * edge));
    openedH = keepSide ? Math.max(openedH, h) : h;
    panel.style.minHeight = collapsible ? (h / scale) + 'px' : '';
    panel.style.maxHeight = (h / scale) + 'px';     // back into layout pixels
    const wantLeft = Math.max(b.left, Math.min(r.left, b.left + b.width - m - panel.offsetWidth * scale));
    // Anchor to the trigger, then clamp so the whole panel stays within the
    // breathing margins (on a tiny screen it may overlap the trigger —
    // visible-and-scrollable beats clipped-and-unreachable).
    const top = placeBelow ? r.bottom + gap : r.top - gap - h;
    const wantTop = Math.max(b.top + edge, Math.min(top, b.top + b.height - edge - h));
    panel.style.left = wantLeft + 'px';
    panel.style.top = wantTop + 'px';

    // A transformed, filtered or contained ancestor becomes the containing block
    // for `position: fixed`, so the coordinates just written are measured from
    // THAT box rather than the viewport and the panel lands away from its
    // trigger — which is what happened inside the Claude tile's panel. Rather
    // than hunt for which ancestor did it, measure where the panel actually
    // ended up and correct by the difference; that holds whatever the cause.
    //
    // The correction is in layout pixels while the error was measured on screen,
    // so it is divided by the same ratio. Without that it undershoots by exactly
    // the scale factor and one pass never lands.
    const got = panel.getBoundingClientRect();
    const dx = (wantLeft - got.left) / scale, dy = (wantTop - got.top) / scale;
    if (dx || dy) {
      panel.style.left = (wantLeft + dx) + 'px';
      panel.style.top = (wantTop + dy) + 'px';
    }
  }

  function open() {
    _csCloseAll();   // only one dropdown open at a time
    renderOptions();
    wrap.classList.add('cs-open');
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    positionPanel();
    // The current choice in view, and the start point for the arrow keys.
    const chosen = panel.querySelector('.cs-option.cs-selected');
    if (chosen) setActive(chosen);
    // Straight into the search box, except after a finger tap: there the focus
    // would raise the on-screen keyboard over the list being looked at.
    if (hasSearch && lastPointer !== 'touch') {
      const inp = panel.querySelector('.cs-search-input');
      if (inp) setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch { /* detached */ } }, 30);
    }
  }

  function close() {
    wrap.classList.remove('cs-open');
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  wrap._csClose = close;

  // ── Events ─────────────────────────────────────────────────

  let lastPointer = '';
  trigger.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || ''; }, { passive: true });

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();   // if the <select> sits in a <label>, don't let the click also activate the hidden native control
    // One press can produce TWO clicks when the first one rebuilds the DOM
    // underneath the pointer. Measured in the Deck key editor, which is the
    // place that does exactly that: pressing "+ Add action" rebuilds the whole
    // action list inside its own click handler, and the browser then fires a
    // SECOND trusted click — detail 0, so not a pointer gesture, and carrying
    // the original gesture's timestamp — at whatever now sits under the pointer.
    // What now sits there is the dropdown this very rebuild created, so the list
    // opened by itself; and choosing an option (which rebuilds the list the same
    // way) re-opened it, which is what "the list does not collapse" looked like.
    // Reported on Discord and reproduced in a browser, in both engines.
    //
    // The discriminator needs no threshold and no guesswork: a click whose
    // gesture happened BEFORE this control existed cannot have been aimed at it.
    // Only for trusted events, so a scripted .click() is never refused.
    if (e.isTrusted && e.timeStamp && e.timeStamp < bornAt) return;
    wrap.classList.contains('cs-open') ? close() : open();
  });

  trigger.addEventListener('keydown', e => {
    lastPointer = '';   // opened from the keyboard: the search box takes the focus
    const opts = Array.from(selectEl.options).filter(o => !o.disabled);   // skip hint rows
    const idx = opts.findIndex(o => o.value === selectEl.value);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      wrap.classList.contains('cs-open') ? close() : open();
    } else if (e.key === 'Escape') {
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(0, Math.min(opts.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      selectEl.value = opts[next].value;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      syncLabel();
    }
  });

  // A <label> around the control makes the trigger its labelled control, and
  // the browser re-sends every click on the label's other content (its caption,
  // its padding, the rows of this very panel) to the trigger as a fresh click.
  // So a tap "outside" on the field closed the list and the forwarded click
  // opened it again, and picking an option did the same: it looked like the
  // list never closed. Cancelling the label's activation for non-interactive
  // content stops the forward; the click itself still bubbles and closes the
  // panel. Capture phase, because option rows stop propagation.
  const hostLabel = wrap.closest('label');
  if (hostLabel && hostLabel.control === trigger) {
    hostLabel.addEventListener('click', (e) => {
      const tgt = e.target;
      if (tgt && tgt.closest && tgt.closest('button, input, select, textarea, a[href]')) return;
      e.preventDefault();
    }, true);
  }

  // Outside-click / Escape / scroll / resize closing is handled by one shared
  // set of global listeners (installed once) — no per-instance leak.
  _csArmGlobal();

  selectEl.addEventListener('change', syncLabel);

  // Assigning `selectEl.value` does NOT fire `change`, so a pane that repaints its
  // controls from state (Settings does this on every sync) would leave the trigger
  // showing the OLD option while the native select already holds the new one. Hand
  // the caller an explicit re-sync — dispatching a synthetic `change` instead would
  // re-enter the element's own onchange and, for a handler that saves and repaints,
  // loop. Same shape as `wrap._csClose` above.
  selectEl._csSync = syncLabel;

  // Re-render when option text changes (i18n language switch updates textContent).
  const obs = new MutationObserver(() => { syncLabel(); });
  obs.observe(selectEl, { subtree: true, characterData: true, childList: true });

  // ── Init ───────────────────────────────────────────────────
  syncLabel();
}

/**
 * Initialise all <select data-custom-select> elements in a given root.
 * Call with no argument to scan the full document.
 *
 * @param {Element} [root=document]
 */
function initAllCustomSelects(root) {
  (root || document).querySelectorAll('select[data-custom-select]').forEach(initCustomSelect);
}
