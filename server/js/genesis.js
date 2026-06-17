'use strict';
// Genesis — AI-composed dashboard pages (opt-in via Settings → Funzioni AI).
// ai.js calls into window.Genesis when the model invokes the genesis_* tools.
// Every mutation goes through the same layout primitives as the manual editor
// (saveDashboardLayout / rebuildDashboardPages / DashboardGrid.addWidgetToPage),
// so AI-created pages behave exactly like hand-made ones: persistent,
// renameable, removable, fully editable in Layout mode.

(function () {
  // Genesis runs inside an AI turn. When the AI overlay (voice orb or chat) is
  // open, its reply already narrates what was built, so a toast on top of it is
  // redundant and overlaps the message — surface it only when the overlay is
  // closed (e.g. Genesis fired from a Deck key without the UI open).
  function genesisToast(message) {
    if (document.body.classList.contains('ai-open')) return;
    if (typeof showHubToast === 'function') showHubToast('Genesis', message, '');
  }

  function validWidgetIds(list) {
    const known = new Set(typeof DASHBOARD_WIDGET_IDS !== 'undefined' ? DASHBOARD_WIDGET_IDS : []);
    const seen = new Set();
    const out = [];
    (Array.isArray(list) ? list : []).forEach(w => {
      const id = String(w || '').trim().toLowerCase();
      if (known.has(id) && !seen.has(id)) { seen.add(id); out.push(id); }
    });
    return out;
  }

  // The model may reference a page by id or by its visible name.
  function findPage(layout, ref) {
    const needle = String(ref || '').trim().toLowerCase();
    if (!needle) return null;
    return layout.pages.find(p => p.id.toLowerCase() === needle)
      || layout.pages.find(p => (p.name || '').trim().toLowerCase() === needle)
      || null;
  }

  function withTransition(fn) {
    if (document.startViewTransition) document.startViewTransition(fn);
    else fn();
  }

  // When Genesis places the "deck" widget on a page, remember WHICH page so a
  // genesis_setup_deck call in the same turn targets that tile's instance —
  // never the user's already-configured base deck on another page.
  let lastDeckPageId = null;

  // Compact snapshot sent with every AI turn (mirrors the deckProfiles
  // pattern): the model needs to know what exists before composing.
  function describeState() {
    try {
      const layout = getDashboardLayout();
      const pages = layout.pages.map(p => ({
        id: p.id,
        name: (p.name || '').trim() || p.id,
        widgets: DASHBOARD_WIDGET_IDS.filter(w =>
          layout.widgets[w] && layout.widgets[w].visible && layout.widgets[w].page === p.id),
      }));
      return { pages, availableWidgets: DASHBOARD_WIDGET_IDS.slice(), maxPages: DASHBOARD_PAGES_MAX };
    } catch {
      return null;
    }
  }

  // Create a new page named `name`, place `widgets` on it, navigate to it.
  function composePage(name, widgets) {
    const layout = getDashboardLayout();
    if (layout.pages.length >= DASHBOARD_PAGES_MAX) return false;
    const ids = validWidgetIds(widgets);
    if (!ids.length) return false;
    const pageName = clampPageName(name, '') || ('Page ' + (layout.pages.length + 1));
    const pageId = 'page-' + Date.now().toString(36);
    layout.pages.push({ id: pageId, name: pageName });
    saveDashboardLayout(layout);
    if (ids.includes('deck')) lastDeckPageId = pageId;
    withTransition(() => {
      rebuildDashboardPages();
      // addWidgetToPage re-reads and re-saves the layout per widget, so each
      // one lands in the first free slot of the fresh page.
      if (window.DashboardGrid) {
        ids.forEach(w => window.DashboardGrid.addWidgetToPage(w, pageId));
        // First-free-slot placement keeps each widget's last size, which makes
        // AI-composed pages ragged. Re-pack into a balanced stock-like grid.
        if (typeof window.DashboardGrid.packPageItems === 'function') {
          const fresh = getDashboardLayout();
          window.DashboardGrid.packPageItems(fresh, pageId);
          saveDashboardLayout(fresh);
          if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
        }
      }
      if (window.DashboardPager && typeof window.DashboardPager.goToPage === 'function') {
        window.DashboardPager.goToPage(pageId);
      }
    });
    if (typeof refreshDashboardLayoutEditor === 'function') refreshDashboardLayoutEditor();
    if (typeof t === 'function') genesisToast(t('genesis_page_created').replace('{name}', pageName));
    return true;
  }

  // Add widgets to an existing page (referenced by id or name), then show it.
  function addWidgets(pageRef, widgets) {
    const layout = getDashboardLayout();
    const page = findPage(layout, pageRef);
    if (!page) return false;
    const ids = validWidgetIds(widgets);
    if (!ids.length) return false;
    if (ids.includes('deck')) lastDeckPageId = page.id;
    withTransition(() => {
      if (window.DashboardGrid) ids.forEach(w => window.DashboardGrid.addWidgetToPage(w, page.id));
      if (window.DashboardPager && typeof window.DashboardPager.goToPage === 'function') {
        window.DashboardPager.goToPage(page.id);
      }
    });
    return true;
  }

  // Remove a page by id or name. Delegates to removeDashboardPage, which keeps
  // its own safety net (never below one page, confirm when modules are lost).
  function removePage(pageRef) {
    const layout = getDashboardLayout();
    const page = findPage(layout, pageRef);
    if (!page) return false;
    if (typeof removeDashboardPage === 'function') removeDashboardPage(page.id);
    return true;
  }

  // ── Deck composition ──────────────────────────────────────────────────────
  // The model picks from this fixed enum; each entry maps to a real Deck action
  // that validateAction re-checks, so raw AI output never reaches the config.
  const DECK_HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
  const DECK_ACTION_MAP = {
    media_playpause: () => ({ type: 'media', cmd: 'playpause' }),
    media_next: () => ({ type: 'media', cmd: 'next' }),
    media_prev: () => ({ type: 'media', cmd: 'previous' }),
    mic_toggle: () => ({ type: 'micMute', mode: 'toggle' }),
    volume_mute: () => ({ type: 'volume', mode: 'mute' }),
    volume_up: () => ({ type: 'volume', mode: 'up' }),
    volume_down: () => ({ type: 'volume', mode: 'down' }),
    app_mixer: () => ({ type: 'appMixer' }),
    ai_voice: () => ({ type: 'ai', mode: 'voice', prompt: '' }),
    ai_chat: () => ({ type: 'ai', mode: 'open', prompt: '' }),
    ai_prompt: (v) => (v ? { type: 'ai', mode: 'prompt', prompt: v } : null),
    lighting_color: (v) => ({ type: 'lighting', mode: 'set', color: DECK_HEX_RE.test(v) ? v : '#2b6cff', style: 'solid' }),
    open_url: (v) => (v ? { type: 'openUrl', url: v } : null),
    hotkey: (v) => (v ? { type: 'hotkey', keys: v } : null),
    obs_record: () => ({ type: 'obsRecord', mode: 'toggle' }),
    obs_stream: () => ({ type: 'obsStream', mode: 'toggle' }),
    obs_scene: (v) => (v ? { type: 'obsScene', scene: v } : null),
  };

  // Find the deck tile instance living on `pageId`: the base widget if it is
  // shown there, else a duplicated copy (deck~xxxx) placed on that page.
  function deckInstanceOnPage(pageId) {
    const layout = getDashboardLayout();
    const base = layout.widgets && layout.widgets.deck;
    if (base && base.visible && base.page === pageId) return 'deck';
    const copy = (Array.isArray(layout.copies) ? layout.copies : [])
      .find(c => c && c.widget === 'deck' && c.page === pageId);
    return copy ? copy.id : null;
  }

  // Build a ready-to-use Deck profile from the model's genesis_setup_deck args.
  // Every key is mapped through DECK_ACTION_MAP and validated by DeckActions;
  // Deck.applyGenesisDeck then re-normalizes the whole config before saving.
  function setupDeck(args) {
    if (!window.Deck || typeof window.Deck.applyGenesisDeck !== 'function') return false;
    const list = Array.isArray(args && args.keys) ? args.keys.slice(0, 32) : [];
    const keys = [];
    list.forEach(k => {
      if (!k || typeof k !== 'object') return;
      const make = DECK_ACTION_MAP[String(k.action || '').trim()];
      const value = String(k.value || '').trim().slice(0, 300);
      const action = make ? make(value) : null;
      const valid = action && window.DeckActions ? window.DeckActions.validateAction(action) : null;
      if (!valid) return;
      const key = {
        kind: 'action',
        title: String(k.title || '').trim().slice(0, 40),
        icon: { type: 'emoji', value: String(k.icon || '').trim().slice(0, 8) || '⭐' },
        press: 'glow',
        triggers: { tap: valid },
      };
      const bg = String(k.color || '').trim();
      if (DECK_HEX_RE.test(bg)) { key.bg = bg; key.pressColor = bg; }
      const led = String(k.ledColor || '').trim();
      if (DECK_HEX_RE.test(led)) key.light = { when: 'press', color: led, style: 'solid' };
      keys.push(key);
    });
    if (!keys.length) return false;
    const spec = {
      profile: String((args && args.profile) || '').trim().slice(0, 40),
      cols: args && args.cols,
      rows: args && args.rows,
      keys,
    };
    const apply = (instanceId) => {
      const ok = window.Deck.applyGenesisDeck(Object.assign({ instanceId }, spec));
      if (ok && typeof t === 'function') {
        const name = spec.profile || 'Deck';
        genesisToast(t('genesis_deck_created').replace('{name}', name));
      }
      return ok;
    };
    // A genesis_compose_page in the same turn places the deck inside an async
    // view transition, so its tile/copy may not be in the layout yet: poll
    // briefly for the instance on that page before giving up. Without a
    // composed page (user asked to set up THEIR deck), target the base deck.
    const pageId = lastDeckPageId;
    if (!pageId) return apply('deck');
    lastDeckPageId = null;
    let tries = 0;
    const attempt = () => {
      const instanceId = deckInstanceOnPage(pageId);
      if (instanceId) { apply(instanceId); return; }
      if (++tries < 20) setTimeout(attempt, 150);
    };
    attempt();
    return true;
  }

  window.Genesis = { describeState, composePage, addWidgets, removePage, setupDeck };
}());
