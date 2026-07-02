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

  // Map the model's coarse size words to relative tile widths for packPageItems
  // (1 = normal, 2 = wide, 3 = full-ish). Keyed by widget id. Unknown words are
  // ignored, so a missing/odd size just leaves the tile at its balanced default.
  const SIZE_WEIGHTS = { small: 1, medium: 1, normal: 1, large: 2, big: 2, wide: 2, xl: 3, full: 3 };
  function sizesToWeights(sizes) {
    const map = {};
    (Array.isArray(sizes) ? sizes : []).forEach(s => {
      if (!s || typeof s !== 'object') return;
      const id = String(s.widget || '').trim().toLowerCase();
      const weight = SIZE_WEIGHTS[String(s.size || '').trim().toLowerCase()];
      if (id && weight) map[id] = weight;
    });
    return map;
  }

  // Merge the requested widget groups into tabbed tiles on `pageId`. Each group is
  // a list of widget ids already placed on the page; the first becomes the tab
  // target and the rest are MOVED into it (never duplicated). A widget already
  // consumed by an earlier group — or not standalone on this page — is skipped, so
  // the model can't accidentally group a tile twice.
  function applyTabGroups(pageId, groups) {
    const tg = window.DashboardTabGroups;
    if (!tg || typeof tg.addAsTab !== 'function' || !Array.isArray(groups)) return;
    // Resolve a requested base widget id to the actual tile instance living on this
    // page and still standalone (not already tabbed): the base widget itself if
    // it's shown here, otherwise a live copy of it placed here (addWidgetToPage
    // duplicates a widget that was already visible on another page). Returns null
    // if there is no ungrouped instance to move — so the model naming a widget it
    // already uses elsewhere still gets its copy grouped instead of a silent no-op.
    const instanceOnPage = (baseId) => {
      const layout = getDashboardLayout();
      const inGroup = (id) => (typeof tg.widgetGroupOf === 'function' ? tg.widgetGroupOf(layout.groups, id) : null);
      const base = layout.widgets[baseId];
      if (base && base.visible && base.page === pageId && !inGroup(baseId)) return baseId;
      const copy = (Array.isArray(layout.copies) ? layout.copies : [])
        .find(c => c && c.widget === baseId && c.page === pageId && !inGroup(c.id));
      return copy ? copy.id : null;
    };
    groups.forEach(grp => {
      const usable = [];
      validWidgetIds(grp).forEach(baseId => {
        const inst = instanceOnPage(baseId);
        if (inst && !usable.includes(inst)) usable.push(inst);
      });
      if (usable.length < 2) return;
      const target = usable[0];
      usable.slice(1).forEach(m => tg.addAsTab(m, target, { move: true }));
    });
  }

  // Re-pack a page into a balanced grid, honouring optional per-widget size hints.
  function repackPage(pageId, weights) {
    if (!window.DashboardGrid || typeof window.DashboardGrid.packPageItems !== 'function') return;
    const fresh = getDashboardLayout();
    window.DashboardGrid.packPageItems(fresh, pageId, weights);
    saveDashboardLayout(fresh);
    if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
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
  // opts.tabs — arrays of widget ids to merge into tabbed tiles.
  // opts.sizes — [{widget, size}] hints so key tiles get wider than the default.
  function composePage(name, widgets, opts) {
    const layout = getDashboardLayout();
    if (layout.pages.length >= DASHBOARD_PAGES_MAX) return false;
    const ids = validWidgetIds(widgets);
    if (!ids.length) return false;
    const pageName = clampPageName(name, '') || ('Page ' + (layout.pages.length + 1));
    const pageId = 'page-' + Date.now().toString(36);
    layout.pages.push({ id: pageId, name: pageName });
    saveDashboardLayout(layout);
    if (ids.includes('deck')) lastDeckPageId = pageId;
    const weights = sizesToWeights(opts && opts.sizes);
    withTransition(() => {
      rebuildDashboardPages();
      // addWidgetToPage re-reads and re-saves the layout per widget, so each
      // one lands in the first free slot of the fresh page.
      if (window.DashboardGrid) {
        ids.forEach(w => window.DashboardGrid.addWidgetToPage(w, pageId));
        // Merge any requested tab groups BEFORE packing, so grouped members
        // collapse into one tile and the pack lays out the remaining tiles evenly.
        applyTabGroups(pageId, opts && opts.tabs);
        // First-free-slot placement keeps each widget's last size, which makes
        // AI-composed pages ragged. Re-pack into a balanced stock-like grid.
        repackPage(pageId, weights);
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
  // opts.tabs groups the newly added (and/or existing) widgets into tabbed tiles.
  // The existing tiles are NOT repacked — only the requested grouping is applied —
  // so a user's hand-tuned layout is preserved.
  function addWidgets(pageRef, widgets, opts) {
    const layout = getDashboardLayout();
    const page = findPage(layout, pageRef);
    if (!page) return false;
    const ids = validWidgetIds(widgets);
    if (!ids.length) return false;
    if (ids.includes('deck')) lastDeckPageId = page.id;
    withTransition(() => {
      if (window.DashboardGrid) ids.forEach(w => window.DashboardGrid.addWidgetToPage(w, page.id));
      applyTabGroups(page.id, opts && opts.tabs);
      if (window.DashboardPager && typeof window.DashboardPager.goToPage === 'function') {
        window.DashboardPager.goToPage(page.id);
      }
    });
    return true;
  }

  // Mirror/duplicate a single widget onto another page (by id or name). Duplicable
  // widgets (media, mic, tasks, …) get a live copy; a non-duplicable widget placed
  // for the first time simply appears there. Delegates to the same grid primitive
  // the manual "duplicate" affordance uses, so copies behave identically.
  function duplicateWidget(widgetRef, pageRef) {
    const layout = getDashboardLayout();
    const page = findPage(layout, pageRef);
    if (!page) return false;
    const ids = validWidgetIds([widgetRef]);
    if (!ids.length || !window.DashboardGrid) return false;
    const widgetId = ids[0];
    // A non-duplicable widget is a singleton: if it's already placed somewhere,
    // handing it to addWidgetToPage would RELOCATE it (making it vanish from the
    // other page) rather than mirror it. Refuse instead of moving it.
    const DI = window.DashboardInstances;
    const w = layout.widgets[widgetId];
    const tg = window.DashboardTabGroups;
    const inGroup = (w && tg && typeof tg.widgetGroupOf === 'function') ? tg.widgetGroupOf(layout.groups, widgetId) : null;
    const placed = !!(w && w.visible) || !!inGroup
      || (Array.isArray(layout.copies) && layout.copies.some(c => c && c.widget === widgetId));
    if (placed && DI && !DI.isDuplicable(widgetId)) return false;
    if (widgetId === 'deck') lastDeckPageId = page.id;
    withTransition(() => {
      window.DashboardGrid.addWidgetToPage(widgetId, page.id);
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
  // Friendly enum → real Deck action shape. Every result is re-checked by
  // DeckActions.validateAction before it can reach the config, so the model can
  // never inject an unknown type or stray field. Covers the full Deck catalog so
  // Genesis can wire any key the dashboard itself supports.
  const DECK_ACTION_MAP = {
    // media
    media_playpause: () => ({ type: 'media', cmd: 'playpause' }),
    media_next: () => ({ type: 'media', cmd: 'next' }),
    media_prev: () => ({ type: 'media', cmd: 'previous' }),
    play_sound: (v) => (v ? { type: 'playSound', file: v, mode: 'play' } : null),
    // audio
    mic_toggle: () => ({ type: 'micMute', mode: 'toggle' }),
    volume_mute: () => ({ type: 'volume', mode: 'mute' }),
    volume_up: () => ({ type: 'volume', mode: 'up' }),
    volume_down: () => ({ type: 'volume', mode: 'down' }),
    app_mixer: () => ({ type: 'appMixer' }),
    app_volume_up: (v) => (v ? { type: 'appVolume', app: v, mode: 'up' } : null),
    app_volume_down: (v) => (v ? { type: 'appVolume', app: v, mode: 'down' } : null),
    app_mute: (v) => (v ? { type: 'appMute', app: v, mode: 'toggle' } : null),
    // ai
    ai_voice: () => ({ type: 'ai', mode: 'voice', prompt: '' }),
    ai_chat: () => ({ type: 'ai', mode: 'open', prompt: '' }),
    ai_prompt: (v) => (v ? { type: 'ai', mode: 'prompt', prompt: v } : null),
    // lighting
    lighting_color: (v) => ({ type: 'lighting', mode: 'set', color: DECK_HEX_RE.test(v) ? v : '#2b6cff', style: 'solid' }),
    // system
    open_app: (v) => (v ? { type: 'openApp', path: v } : null),
    open_file: (v) => (v ? { type: 'openFile', path: v } : null),
    open_store_app: (v) => (v ? { type: 'openStoreApp', appId: v } : null),
    open_url: (v) => (v ? { type: 'openUrl', url: v } : null),
    hotkey: (v) => (v ? { type: 'hotkey', keys: v } : null),
    webhook: (v) => (v ? { type: 'webhook', url: v, method: 'POST', body: '' } : null),
    // obs
    obs_record: () => ({ type: 'obsRecord', mode: 'toggle' }),
    obs_stream: () => ({ type: 'obsStream', mode: 'toggle' }),
    obs_scene: (v) => (v ? { type: 'obsScene', scene: v } : null),
    obs_scene_next: () => ({ type: 'obsSceneNext' }),
    // twitch
    twitch_clip: () => ({ type: 'twitchClip' }),
    twitch_marker: (v) => ({ type: 'twitchMarker', description: v || '' }),
    twitch_ad: (v) => ({ type: 'twitchAd', length: v || '60' }),
    twitch_title: (v) => (v ? { type: 'twitchTitle', title: v } : null),
    twitch_game: (v) => (v ? { type: 'twitchGame', game: v } : null),
    twitch_chat: (v) => (v ? { type: 'twitchChat', message: v } : null),
    twitch_shoutout: (v) => (v ? { type: 'twitchShoutout', login: v } : null),
    twitch_chatmode: (v) => ({ type: 'twitchChatMode', mode: v || 'off' }),
    // youtube / streamer.bot
    yt_broadcast: (v) => ({ type: 'ytBroadcast', mode: v || 'toggle' }),
    sb_action: (v) => (v ? { type: 'sbDoAction', action: v } : null),
    // remote control
    remote_disconnect: () => ({ type: 'remoteDisconnect' }),
    remote_block: (v) => ({ type: 'remoteBlock', mode: v || 'toggle' }),
    remote_screen_cycle: () => ({ type: 'remoteScreenCycle' }),
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

  window.Genesis = { describeState, composePage, addWidgets, removePage, setupDeck, duplicateWidget };
}());
