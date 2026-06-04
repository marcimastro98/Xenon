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
 * @param {HTMLSelectElement} selectEl
 */
function initCustomSelect(selectEl) {
  if (!selectEl || selectEl.dataset.csInit) return;
  selectEl.dataset.csInit = '1';
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

  function currentLabel() {
    const opt = Array.from(selectEl.options).find(o => o.value === selectEl.value);
    return opt ? opt.textContent.trim() : '';
  }

  function syncLabel() {
    labelEl.textContent = currentLabel();
  }

  function renderOptions() {
    panel.textContent = '';
    Array.from(selectEl.options).forEach(opt => {
      const li = document.createElement('li');
      li.className = 'cs-option' + (opt.value === selectEl.value ? ' cs-selected' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(opt.value === selectEl.value));
      li.dataset.value = opt.value;
      li.textContent = opt.textContent.trim();
      li.addEventListener('click', e => {
        e.stopPropagation();
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        renderOptions();
        close();
      });
      panel.appendChild(li);
    });
  }

  // ── Open / close ───────────────────────────────────────────

  const useFixed = selectEl.hasAttribute('data-cs-fixed');

  // Anchor the panel to the trigger with position:fixed so a scrollable/clipping
  // ancestor (e.g. a modal body) can't cut it off. Clamp to the viewport, cap the
  // height to the available space (the panel scrolls when the list is long), and
  // open above the trigger when there's more room there.
  function positionPanel() {
    if (!useFixed) return;
    const r = trigger.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, m = 8, gap = 5;
    panel.style.position = 'fixed';
    panel.style.margin = '0';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.minWidth = r.width + 'px';
    panel.style.maxHeight = 'none';                 // measure the natural height first
    const natural = panel.scrollHeight;
    const spaceBelow = vh - r.bottom - gap - m;
    const spaceAbove = r.top - gap - m;
    // Drop below unless it doesn't fit and there's more room above.
    const placeBelow = natural <= spaceBelow || spaceBelow >= spaceAbove;
    const avail = Math.max(96, placeBelow ? spaceBelow : spaceAbove);
    const h = Math.min(natural, avail);
    panel.style.maxHeight = h + 'px';
    let left = Math.min(r.left, vw - m - panel.offsetWidth);
    panel.style.left = Math.max(m, left) + 'px';
    panel.style.top = (placeBelow ? r.bottom + gap : r.top - gap - h) + 'px';
  }

  function open() {
    _csCloseAll();   // only one dropdown open at a time
    renderOptions();
    wrap.classList.add('cs-open');
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    positionPanel();
  }

  function close() {
    wrap.classList.remove('cs-open');
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  wrap._csClose = close;

  // ── Events ─────────────────────────────────────────────────

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();   // if the <select> sits in a <label>, don't let the click also activate the hidden native control
    wrap.classList.contains('cs-open') ? close() : open();
  });

  trigger.addEventListener('keydown', e => {
    const opts = Array.from(selectEl.options);
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

  // Outside-click / Escape / scroll / resize closing is handled by one shared
  // set of global listeners (installed once) — no per-instance leak.
  _csArmGlobal();

  // Re-sync label when the native select changes programmatically
  // (e.g. via selectEl.value = '...' in JS).
  selectEl.addEventListener('change', syncLabel);

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
