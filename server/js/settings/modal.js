// The settings window itself: opening and closing it, its pages and columns, its status line and
// its ask-for-a-name box.
'use strict';

let settingsStatusTimer = null;

// In-app text prompt / confirm. The Xeneon Edge WebView makes native
// prompt()/confirm() unreliable and clumsy on a touchscreen, so we render a small
// modal reusing the shared .preset-modal styling. Returns a Promise resolving to
// the entered string (text mode) or true (confirm mode), or null when cancelled.
let settingsPromptSeq = 0;
function settingsPrompt(opts) {
  const o = opts || {};
  const isConfirm = o.type === 'confirm';
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'preset-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'preset-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', o.title || '');
    const head = document.createElement('div');
    head.className = 'preset-modal-head';
    const h = document.createElement('h3');
    h.className = 'preset-modal-title';
    h.textContent = o.title || '';
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'preset-modal-close';
    x.setAttribute('aria-label', t('close')); x.textContent = '✕';
    head.appendChild(h); head.appendChild(x);
    const body = document.createElement('div');
    body.className = 'preset-modal-body';
    if (o.message) {
      const msg = document.createElement('p');
      msg.className = 'preset-modal-desc';
      msg.textContent = o.message;
      body.appendChild(msg);
    }
    let input = null;
    if (!isConfirm) {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'settings-text-input';
      input.value = o.value != null ? String(o.value) : '';
      if (o.placeholder) input.placeholder = o.placeholder;
      input.maxLength = o.maxLength || 120;
      body.appendChild(input);
    }
    const row = document.createElement('div');
    row.className = 'preset-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'settings-btn subtle';
    cancel.textContent = o.cancelLabel || t('dlg_cancel');
    const ok = document.createElement('button');
    // `danger`: the confirm button for something that destroys data. It is
    // styled as the destructive action rather than the inviting one, and the
    // focus below goes to Cancel — a dialog that opens with the destructive
    // button focused is one keypress from doing the thing it is asking about.
    ok.type = 'button'; ok.className = o.danger === true ? 'settings-btn danger' : 'settings-btn primary';
    ok.textContent = o.okLabel || t('dlg_save');
    row.appendChild(cancel); row.appendChild(ok);
    body.appendChild(row);
    modal.appendChild(head); modal.appendChild(body);
    overlay.appendChild(modal);

    const freezeToken = 'settings-prompt:' + (++settingsPromptSeq);
    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      overlay.remove();
      letGo();
      if (typeof window.ambientFreeze === 'function') window.ambientFreeze(freezeToken, false);
      resolve(val);
    };
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(input.value); }
      });
    }
    x.addEventListener('click', () => finish(null));
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => finish(input ? input.value : true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    document.body.appendChild(overlay);
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze(freezeToken, true);
    const letGo = window.DialogFocus.hold(modal, {
      start: input || (o.danger === true ? cancel : ok),
      onEsc: () => finish(null),
    });
    if (input) input.select();
  });
}

function renderSettingsModal() {
  renderThemeGallery();
  syncSettingsControls();
}

function setSettingsStatus(messageKey, mode) {
  const el = $('settings-status');
  if (!el) return;
  clearTimeout(settingsStatusTimer);
  el.classList.remove('ok', 'error');
  el.dataset.messageKey = messageKey || '';
  if (mode) el.classList.add(mode);
  el.textContent = messageKey ? t(messageKey) : '';
  if (messageKey) settingsStatusTimer = setTimeout(() => setSettingsStatus('', ''), 2600);
}

function syncLangButtons() {
  const sel = document.getElementById('settings-lang-select');
  if (sel && sel.value !== lang) {
    sel.value = lang;
    // Notify the custom-select wrapper (custom-select.js) so its visible label
    // tracks a programmatic language change (e.g. loaded from settings, or set by
    // Xenon AI). setLang() early-returns on an unchanged code, so the onchange
    // handler firing here cannot recurse. The flag tells setLang this is a pure
    // label sync, NOT a user pick: without it, merely opening Settings on an
    // install whose language was never chosen would persist this surface's
    // browser-derived locale server-wide and flip every other screen's language.
    window._langSelectSyncing = true;
    try { sel.dispatchEvent(new Event('change', { bubbles: true })); }
    finally { window._langSelectSyncing = false; }
  }
}

let _settingsCat = 'appearance';
// A card shown only where its feature runs, decided by a probe that answers
// later: it stays out of every category until then, and a late answer never
// shows it inside another category.
function setSettingsCardAvailable(card, ok) {
  if (!card) return;
  if (ok) delete card.dataset.unavailable;
  else card.dataset.unavailable = '1';
  const open = document.getElementById('settings-content');
  card.hidden = !ok || !open || card.dataset.settingsCat !== open.dataset.cat;
}

function settingsSetCategory(cat) {
  // One page holds both now; links and deep links may still name the old one.
  if (cat === 'codex') cat = 'claude';
  _settingsCat = cat;
  if (window.SettingsSearch) SettingsSearch.leave();
  if (cat === 'appearance') refreshMediaVizStatus();
  const content = document.getElementById('settings-content');
  if (content) {
    content.dataset.cat = cat;
    content.querySelectorAll('[data-settings-cat]').forEach(el => {
      el.hidden = el.dataset.settingsCat !== cat || el.dataset.unavailable === '1';
    });
    content.scrollTop = 0;
  }
  document.querySelectorAll('.settings-nav-btn').forEach(b => {
    const on = b.dataset.settingsCat === cat;
    b.classList.toggle('active', on);
    // A link from a tile can land on a page whose row is below the fold of the rail.
    if (on) b.scrollIntoView({ block: 'nearest' });
  });
  paintSettingsPageTitle(cat);
  // Slideshow thumbnails paint when its pane opens (and update live via applyHubSettings).
  if (cat === 'slideshow') renderSlideshowSettings();
  if (cat === 'island') renderDynamicIslandSources();
  if (window.SettingsBarPreview) SettingsBarPreview.page(cat);
  if (cat === 'search') renderSearchDiskSettings();
  if ((cat === 'capture' || cat === 'performance') && window.CaptureSettingsPane) CaptureSettingsPane.show();
  if (cat === 'performance') for (const p of [window.SensorSourcesPage, window.GameIgnorePage]) if (p) p.show();
  if (cat === 'performance') syncExpanderSummaries();
  // The monitor list is live: rendered on open, and re-rendered by the shell's
  // push when a display is plugged in or out while the panel is on screen.
  if (cat === 'display') renderSurfaceSection();
  // News feeds live in the widget, which may not be on the dashboard at all
  // while the ticker still streams news — mount the same editor here, and let
  // it go when another pane is showing so it stops taking repaints.
  if (window.NewsWidget) NewsWidget.mountFeedManager(cat === 'stocks' ? $('settings-news-feeds') : null);
  // Read when the pane opens rather than on every settings render: it is one
  // request, and the answer only changes when this same pane or an unlock
  // changes it.
  if (cat === 'sdk') syncSupporterCodeBox();
  // The supporter count under the support buttons (js/support-goal.js). Cached
  // an hour by the server, so opening the pane again costs nothing.
  if (cat === 'support' && window.XenonSupportGoal) XenonSupportGoal.fill($('settings-support-goal'));
  packSettingsColumns();
}

// The page is named by its row in the rail, so the two never disagree, and the same i18n
// key means a change of language reaches it.
function paintSettingsPageTitle(cat) {
  const title = $('settings-page-title');
  if (!title) return;
  const row = Array.from(document.querySelectorAll('#settings-nav .settings-nav-btn')).find(b => b.dataset.settingsCat === cat);
  const label = row && (row.querySelector('[data-i18n]') || row);
  if (label && label.dataset.i18n) title.dataset.i18n = label.dataset.i18n;
  else delete title.dataset.i18n;
  title.textContent = label ? label.textContent.trim() : '';
}

// ── Two-column pages pack like a mosaic ─────────────────────────────────────
// A CSS grid places cards in rows: a short card beside a tall one leaves a
// hole under it. With 1px row tracks and each card spanning its own height,
// auto-placement puts every card in the first free room instead. Re-run when
// a card changes height (a section unfolds, a list grows) and on resize;
// setting a span never changes the card's own size, so there is no loop.
const PACK_GAP = 28;
let _packRaf = 0;
let _packObserver = null;
function packSettingsColumns() {
  const content = $('settings-content');
  if (!content) return;
  const twoCol = getComputedStyle(content).gridTemplateColumns.split(' ').length >= 2;
  const cards = Array.from(content.children);
  if (!twoCol) {
    content.classList.remove('is-packed');
    cards.forEach((c) => c.style.removeProperty('grid-row-end'));
    return;
  }
  content.classList.add('is-packed');
  for (const c of cards) {
    if (c.hidden) { c.style.removeProperty('grid-row-end'); continue; }
    const h = c.getBoundingClientRect().height;
    c.style.setProperty('grid-row-end', 'span ' + (Math.ceil(h) + PACK_GAP), 'important');
  }
  if (!_packObserver && typeof ResizeObserver === 'function') {
    _packObserver = new ResizeObserver(() => {
      if (_packRaf) return;
      _packRaf = requestAnimationFrame(() => { _packRaf = 0; packSettingsColumns(); });
    });
    cards.forEach((c) => _packObserver.observe(c));
    window.addEventListener('resize', () => {
      if (_packRaf) return;
      _packRaf = requestAnimationFrame(() => { _packRaf = 0; packSettingsColumns(); });
    });
  }
}

// The Settings overlay is a full-viewport frosted backdrop (backdrop-filter blur),
// so it triggers the same ambient re-blur flicker as the update dialog on some GPUs
// (issue #56). Freeze the ambient while it's open; the token-set registry keeps it
// frozen if a frosted overlay (e.g. the update dialog) is stacked on top.
function freezeSettingsAmbient(on) {
  try {
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('settings', on);
  } catch { /* ignore */ }
}

function toggleSettings() {
  const overlay = $('settings-overlay');
  if (!overlay) return;
  overlay.hidden = !overlay.hidden;
  if (!overlay.hidden) {
    // The lock screen and ambient scenes sit above Settings, and the lock
    // screen's backdrop is see-through, so a Settings opened under one (voice,
    // a paired phone, a shortcut) showed through it. Opening Settings means the
    // user is here: take the screen back first.
    if (window.AmbientMode && AmbientMode.isOpen()) AmbientMode.close();
    // Every open starts on the settings themselves, not on the category list.
    const nav = $('settings-nav');
    if (nav) nav.classList.remove('is-open');
    renderSettingsModal();
    settingsSetCategory(_settingsCat);
    if (window.SettingsSearch) SettingsSearch.onOpen();
    if (window.CaptureSettingsPane) CaptureSettingsPane.probe();
  }
  else if (window.NewsWidget) NewsWidget.mountFeedManager(null);
  freezeSettingsAmbient(!overlay.hidden);
}

// Open Settings, idempotently. `toggleSettings` is a TOGGLE, so calling it to
// "go to Settings" closes the panel whenever it happened to be open already —
// which reads as the whole screen vanishing, and is exactly what happened when
// the screen picker sent the user to the pairing panel.
function openSettings(category) {
  const overlay = $('settings-overlay');
  if (!overlay) return;
  if (overlay.hidden) toggleSettings();
  if (category) settingsSetCategory(category);
}
window.openSettings = openSettings;

function closeSettings() {
  const overlay = $('settings-overlay');
  if (overlay) overlay.hidden = true;
  if (window.NewsWidget) NewsWidget.mountFeedManager(null);
  for (const p of [window.SensorSourcesPage, window.GameIgnorePage]) if (p) p.stop();
  freezeSettingsAmbient(false);
}
