/*
 * Custom dropdown — the one styled <select> replacement for every Xenon widget.
 *
 * iCUE's QtWebEngine renders native <select> popups inconsistently (and styling
 * the popup itself is impossible), so we replace each <select data-custom-select>
 * with a styled button + listbox. The original <select> stays in the DOM (hidden)
 * so all `.value` reads and `change` handlers keep working unchanged.
 *
 * Add `data-cs-fixed` to position the panel with `position: fixed` (anchored to
 * the trigger, clamped to the widget viewport, flips up when there's no room) —
 * needed inside the small, overflow-hidden widget tiles so the panel is never
 * clipped. Port of server/js/custom-select.js, written without `?.`/`??`/arrows
 * /template-literals so the iCUE validator accepts it. Inlined at build time.
 */

var _csGlobalArmed = false;

function _csCloseAll() {
  var open = document.querySelectorAll('.cs-wrap.cs-open');
  for (var i = 0; i < open.length; i++) {
    if (typeof open[i]._csClose === 'function') open[i]._csClose();
  }
}

function _csArmGlobal() {
  if (_csGlobalArmed) return;
  _csGlobalArmed = true;
  document.addEventListener('click', _csCloseAll, { passive: true });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') _csCloseAll(); });
  window.addEventListener('resize', _csCloseAll, { passive: true });
  // capture: catch scrolls inside any container, not just window — but ignore
  // scrolls inside an open panel so a long list can scroll without self-closing.
  window.addEventListener('scroll', function (e) {
    var tgt = e.target;
    if (tgt && tgt.closest && tgt.closest('.cs-panel')) return;
    _csCloseAll();
  }, { passive: true, capture: true });
}

var CS_CHEVRON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5.5 8,10.5 13,5.5"/></svg>';

function initCustomSelect(selectEl) {
  if (!selectEl || selectEl.dataset.csInit) return;
  selectEl.dataset.csInit = '1';
  selectEl.hidden = true;

  var wrap = document.createElement('div');
  wrap.className = 'cs-wrap';
  selectEl.insertAdjacentElement('beforebegin', wrap);

  var trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cs-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  var labelEl = document.createElement('span');
  labelEl.className = 'cs-label';

  var chevron = document.createElement('span');
  chevron.className = 'cs-chevron';
  chevron.innerHTML = CS_CHEVRON;

  trigger.appendChild(labelEl);
  trigger.appendChild(chevron);

  var panel = document.createElement('ul');
  panel.className = 'cs-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;

  wrap.appendChild(trigger);
  wrap.appendChild(panel);

  function currentLabel() {
    var opts = selectEl.options;
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].value === selectEl.value) return opts[i].textContent.trim();
    }
    return '';
  }
  function syncLabel() { labelEl.textContent = currentLabel(); }

  function addOption(opt) {
    var disabled = opt.disabled;
    var li = document.createElement('li');
    li.className = 'cs-option' +
      (opt.value === selectEl.value ? ' cs-selected' : '') +
      (disabled ? ' cs-option-disabled' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(opt.value === selectEl.value));
    if (disabled) li.setAttribute('aria-disabled', 'true');
    li.dataset.value = opt.value;
    if (opt.dataset && opt.dataset.csIcon) {
      var ic = document.createElement('span');
      ic.className = 'cs-option-ico';
      ic.innerHTML = opt.dataset.csIcon;          // trusted inline SVG from caller
      li.appendChild(ic);
    }
    var txt = document.createElement('span');
    txt.className = 'cs-option-label';
    txt.textContent = opt.textContent.trim();
    li.appendChild(txt);
    li.addEventListener('click', function (e) {
      e.stopPropagation();
      if (disabled) return;                        // hint row: select nothing
      selectEl.value = opt.value;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      syncLabel();
      renderOptions();
      close();
    });
    panel.appendChild(li);
  }

  function renderOptions() {
    panel.textContent = '';
    var children = selectEl.children;
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (node.tagName === 'OPTGROUP') {
        var head = document.createElement('li');
        head.className = 'cs-group';
        head.setAttribute('role', 'presentation');
        head.textContent = node.label || '';
        panel.appendChild(head);
        var sub = node.children;
        for (var j = 0; j < sub.length; j++) {
          if (sub[j].tagName === 'OPTION') addOption(sub[j]);
        }
      } else if (node.tagName === 'OPTION') {
        addOption(node);
      }
    }
  }

  var useFixed = selectEl.hasAttribute('data-cs-fixed');

  // Anchor the panel to the trigger with position:fixed so the small,
  // overflow-hidden widget tile can't clip it. Clamp to the widget viewport,
  // cap the height to the room available (the list scrolls when taller), and
  // open above the trigger when there's more space up there.
  function positionPanel() {
    if (!useFixed) return;
    var r = trigger.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight, m = 8, gap = 5;
    panel.style.position = 'fixed';
    panel.style.margin = '0';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.minWidth = r.width + 'px';
    panel.style.maxHeight = 'none';
    var natural = panel.scrollHeight;
    var spaceBelow = vh - r.bottom - gap - m;
    var spaceAbove = r.top - gap - m;
    var placeBelow = natural <= spaceBelow || spaceBelow >= spaceAbove;
    var h = Math.min(natural, vh - 2 * m);
    panel.style.maxHeight = h + 'px';
    var left = Math.min(r.left, vw - m - panel.offsetWidth);
    panel.style.left = Math.max(m, left) + 'px';
    var top = placeBelow ? r.bottom + gap : r.top - gap - h;
    panel.style.top = Math.max(m, Math.min(top, vh - m - h)) + 'px';
  }

  function open() {
    _csCloseAll();                                 // only one open at a time
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

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    e.preventDefault();   // don't let a wrapping <label> re-activate the hidden select
    if (wrap.classList.contains('cs-open')) close(); else open();
  });

  trigger.addEventListener('keydown', function (e) {
    var all = selectEl.options, opts = [];
    for (var i = 0; i < all.length; i++) { if (!all[i].disabled) opts.push(all[i]); }
    var idx = -1;
    for (var k = 0; k < opts.length; k++) { if (opts[k].value === selectEl.value) { idx = k; break; } }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (wrap.classList.contains('cs-open')) close(); else open();
    } else if (e.key === 'Escape') {
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var next = Math.max(0, Math.min(opts.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      if (opts[next]) {
        selectEl.value = opts[next].value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
      }
    }
  });

  _csArmGlobal();

  // Re-sync when the native select changes programmatically (selectEl.value = …).
  selectEl.addEventListener('change', syncLabel);
  // Re-sync when option text changes (language switch updates textContent).
  if (typeof MutationObserver !== 'undefined') {
    var obs = new MutationObserver(function () { syncLabel(); });
    obs.observe(selectEl, { subtree: true, characterData: true, childList: true });
  }

  syncLabel();
}

function initAllCustomSelects(root) {
  var scope = root || document;
  var sels = scope.querySelectorAll('select[data-custom-select]');
  for (var i = 0; i < sels.length; i++) initCustomSelect(sels[i]);
}
