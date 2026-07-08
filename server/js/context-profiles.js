'use strict';

// ── Smart context profiles ──────────────────────────────────────────────────
// Automatically switch dashboard state — which PAGE is shown, the LIGHTING
// effect, the active DECK profile, and the dashboard STYLE (Liquid Glass /
// Pixel Retro) — when the foreground activity changes (gaming / coding /
// writing / streaming / creating / meeting), and put it back when the activity
// ends. It REUSES Performance Mode's single activity concept
// (performance.js classifies the foreground app through the user's custom lists
// and notifies us via PerfMode.onActivityChange) — there is no second detector.
//
// Design notes:
//  • Always overridable: we only act on activity TRANSITIONS, never continuously,
//    and on revert we restore a dimension only if the user hasn't changed it in
//    the meantime (the current value still equals what we applied).
//  • No flicker: a brief Alt-Tab out of a game classifies as 'other' — we delay
//    the revert by a grace period and cancel it if a profiled activity resumes.
//  • Independent of the optimizer: this works whether or not Performance Mode's
//    optimization is enabled — it only borrows the classification.
(function () {
  'use strict';

  // ── Pure decision logic (exported for unit tests) ─────────────────
  // A profile does something only if at least one dimension is set.
  function profileIsActive(profile) {
    return !!(profile && (profile.page || profile.lighting || profile.deck || profile.style));
  }

  // Given the config, the incoming (classified) activity and whether a baseline
  // snapshot is currently held, decide what the controller should do:
  //   'apply'  — this activity has a profile → apply it
  //   'revert' — no profile for this activity → restore the baseline (if any)
  //   'noop'   — nothing to do
  function decideContextAction(config, activity, hasBaseline) {
    if (!config || config.enabled !== true) return 'noop';
    const profile = config.map && config.map[activity];
    if (profileIsActive(profile)) return 'apply';
    if (hasBaseline && config.revertOnExit !== false) return 'revert';
    return 'noop';
  }

  // ── Browser controller ────────────────────────────────────────────
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const REVERT_GRACE_MS = 9000; // ride out brief focus changes before reverting

    // Baseline = the state captured before the FIRST profile of a context chain
    // was applied, so we can restore it. `inContext` is our "hasBaseline" flag.
    let inContext = false;
    let basePage = '', baseDeck = '', baseLighting = '', baseStyle = '';
    let litSnapped = false; // whether we've snapshotted the pre-context lighting
    let appliedPage = '', appliedDeck = '', appliedLighting = '', appliedStyle = '';
    let currentActivity = 'other';
    let revertTimer = null;

    // hubSettings is a shared-script-scope global from settings.js (a top-level
    // `let`, NOT window.hubSettings) — read it by bare name like performance.js does.
    const cfg = () => { try { return (hubSettings && hubSettings.contextProfiles) || null; } catch { return null; } };
    const clearRevertTimer = () => { if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; } };

    // ---- snapshots (read current state) ----
    function snapshotPage() {
      try { return (window.DashboardPager && DashboardPager.getCurrentPage()) || ''; } catch { return ''; }
    }
    function snapshotDeck() {
      try {
        const list = (window.Deck && Deck.listProfiles) ? Deck.listProfiles() : [];
        const active = list.find(p => p.active);
        return active ? active.name : '';
      } catch { return ''; }
    }
    async function snapshotLighting() {
      try {
        const r = await fetch('/api/lighting/status', { cache: 'no-store' });
        const s = await r.json();
        return (s && s.animation && typeof s.animation.style === 'string') ? s.animation.style : '';
      } catch { return ''; }
    }
    function snapshotStyle() {
      // The full active look as a gallery id: a saved custom theme when one
      // matches, else the base 'glass'/'retro'. So revert restores the WHOLE
      // baseline (colours included), not just the skin.
      try {
        if (typeof findActiveThemeId === 'function') return findActiveThemeId();
        return hubSettings.styleMode === 'retro' ? 'retro' : 'glass';
      } catch { return 'glass'; }
    }

    // ---- apply primitives (best-effort, never throw) ----
    function applyPage(id) {
      if (!id) return;
      try { if (window.DashboardPager && DashboardPager.goToPage) DashboardPager.goToPage(id); } catch { /* page gone */ }
    }
    function applyDeck(name) {
      if (!name) return;
      try { if (window.Deck && Deck.switchProfileByName) Deck.switchProfileByName(name); } catch { /* no deck */ }
    }
    async function applyLighting(style) {
      if (!style) return;
      try {
        await fetch('/api/lighting/animation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ style }),
        });
      } catch { /* lighting not set up */ }
    }
    // Dashboard style goes through the SAME write path as the Appearance page
    // (setStyleMode persists + applies + re-syncs the controls), so it survives
    // any settings re-apply mid-game and every surface (browser/iCUE/native app)
    // flips together via the settings sync. Like lighting, it stays persisted if
    // the PC dies mid-context — the user just flips it back.
    function applyStyle(mode) {
      if (!mode) return;
      // applyThemeById handles BOTH a base style ('glass'/'retro' → that style's
      // stock look) and a saved custom theme id (its full snapshot) — the same
      // gallery path the Appearance tab uses, so it persists, applies live and
      // re-syncs every surface. An id that no longer exists simply no-ops.
      try { if (typeof applyThemeById === 'function') applyThemeById(mode); } catch { /* settings not loaded */ }
    }

    async function applyProfile(profile) {
      // Snapshot the baseline once, when entering a context chain, so revert can
      // restore every dimension regardless of which profile touched what.
      if (!inContext) {
        inContext = true;
        basePage = snapshotPage();
        baseDeck = snapshotDeck();
        baseStyle = snapshotStyle();
        litSnapped = false;
      }
      // Lighting has no cheap read, so snapshot it lazily — the first time any
      // profile in the chain actually sets a lighting style.
      if (profile.lighting && !litSnapped) { baseLighting = await snapshotLighting(); litSnapped = true; }

      if (profile.page) { applyPage(profile.page); appliedPage = profile.page; }
      if (profile.deck) { applyDeck(profile.deck); appliedDeck = profile.deck; }
      if (profile.lighting) { applyLighting(profile.lighting); appliedLighting = profile.lighting; }
      if (profile.style && profile.style !== snapshotStyle()) { applyStyle(profile.style); appliedStyle = profile.style; }
    }

    function revert() {
      if (!inContext) return;
      // Polite restore: undo a dimension only if the user hasn't since changed it
      // (current value still equals what we applied). Lighting is best-effort.
      if (appliedPage && basePage && snapshotPage() === appliedPage) applyPage(basePage);
      if (appliedDeck && baseDeck && snapshotDeck() === appliedDeck) applyDeck(baseDeck);
      if (litSnapped && appliedLighting && baseLighting) applyLighting(baseLighting);
      if (appliedStyle && baseStyle && snapshotStyle() === appliedStyle) applyStyle(baseStyle);
      inContext = false;
      appliedPage = appliedDeck = appliedLighting = appliedStyle = '';
      litSnapped = false;
    }

    function scheduleRevert() {
      clearRevertTimer();
      revertTimer = setTimeout(() => { revertTimer = null; revert(); }, REVERT_GRACE_MS);
    }

    async function handleActivity(activity) {
      currentActivity = activity || 'other';
      const config = cfg();
      const action = decideContextAction(config, currentActivity, inContext);
      if (action === 'apply') {
        clearRevertTimer();
        await applyProfile(config.map[currentActivity]);
      } else if (action === 'revert') {
        scheduleRevert();
      }
      // 'noop' → leave everything as-is
    }

    // Re-evaluate when the config changes (Settings) or on first load. When the
    // feature is turned off, drop any pending revert and restore the baseline.
    function refresh() {
      const config = cfg();
      if (!config || config.enabled !== true) {
        clearRevertTimer();
        if (inContext) revert();
        return;
      }
      const a = (window.PerfMode && PerfMode.activity) ? PerfMode.activity() : currentActivity;
      handleActivity(a);
    }

    function init() {
      if (window.PerfMode && typeof PerfMode.onActivityChange === 'function') {
        PerfMode.onActivityChange(handleActivity);
      }
      refresh();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }

    window.ContextProfiles = { refresh };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { profileIsActive, decideContextAction };
  }
})();
