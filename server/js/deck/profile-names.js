// The names the Deck reads off its profiles: the list Xenon AI is given to switch by, and the name
// on the crumb of the one being shown.
'use strict';

(() => {
  const { getConfig, deckInstances } = window.DeckStoreReads;

  function crumbLabel(cfg, state) {
    // The crumb names the profile being SHOWN (a Smart-Profiles auto-switch may
    // temporarily differ from the persisted activeProfile).
    const shownId = (state.volatileProfile && cfg.profiles.some((p) => p.id === state.volatileProfile))
      ? state.volatileProfile : cfg.activeProfile;
    const profile = cfg.profiles.find(p => p.id === shownId) || cfg.profiles[0];
    if (!state.path.length) return profile.name;
    let folder = profile.root, title = profile.name;
    for (const id of state.path) {
      let found = null;
      for (const page of folder.pages) { const k = page.keys.find(key => key && key.kind === 'folder' && key.id === id); if (k) { found = k; break; } }
      if (!found) break;
      title = found.title || title; folder = found.folder;
    }
    return title;
  }

  // The distinct profile names across all deck instances, each flagged if it's the
  // active profile in any instance. Sent to the AI so it can switch by exact name.
  function listProfiles() {
    const seen = new Map();   // lowercased name -> { name, active }
    for (const { instanceId } of deckInstances()) {
      const cfg = getConfig(instanceId);
      for (const p of cfg.profiles) {
        const isActive = p.id === cfg.activeProfile;
        const existing = seen.get(p.name.toLowerCase());
        if (!existing) seen.set(p.name.toLowerCase(), { name: p.name, active: isActive });
        else if (isActive) existing.active = true;
      }
    }
    return Array.from(seen.values());
  }

  window.DeckProfileNames = { crumbLabel, listProfiles };
})();
