// What the deck reads from its store: the saved config of a deck, the profile and key presets, how
// many keys a config or a profile holds, and the lists made from them: the decks on the dashboard,
// the profiles of other decks, and the configs and profiles a removed deck left behind.
'use strict';

(() => {
  const STORE_KEY = 'deck.config.v1';        // { [instanceId]: fullDeckConfig } — each instance owns its config

  const PRESETS_KEY = 'deck.presets.v1';     // saved profile presets [{ id, name, profile }]
  const KEYPRESETS_KEY = 'deck.keypresets.v1'; // saved single-key presets [{ id, name, key }]

  // Display-only auto-fit overrides: instanceId -> fitted config. Auto-fit adapts
  // the grid to the tile size for RENDERING only; it must never write to the
  // durable store, bump the rev, or back up to the server. Persisting a boot-time
  // (often transient) measurement is what made the saved grid drift — different
  // column/row counts on every restart, reshuffling the keys. The durable config
  // changes solely on genuine user edits; auto-fit lives here, in memory, and is
  // recomputed each session. Promoted to durable when the user edits on top of it.
  const displayConfigs = new Map();    // instanceId -> fitted config (render-only)

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  }

  // Effective DURABLE config for an instance: its OWN stored config, normalized.
  // Each Deck instance owns its full config (grid + profiles + keys + view prefs),
  // so an unknown/empty instance returns a blank deck — a newly added Deck tile
  // starts empty instead of inheriting another deck's keys. Bypasses the render-only
  // auto-fit override (use getConfig for the rendered grid).
  function durableConfig(instanceId, all) {
    return window.DeckStore.instanceConfig(window.DeckModel, all || readStore(), instanceId);
  }

  function getConfig(instanceId) {
    // A live auto-fit override (render grid adapted to the tile) takes precedence
    // over the durable store, so edits act on exactly the grid the user sees and
    // promote it to durable on save.
    if (displayConfigs.has(instanceId)) return displayConfigs.get(instanceId);
    return durableConfig(instanceId);
  }

  // Total placed keys across every profile/page of a stored config. 0 = empty.
  // On any parse error returns 1 (treat as non-empty so cleanup never drops it).
  function countConfigKeys(rawConfig) {
    try {
      const cfg = window.DeckModel.normalizeDeckConfig(rawConfig);
      let n = 0;
      const walk = (folder) => {
        for (const page of folder.pages) {
          n += page.keys.filter(Boolean).length;
          for (const k of page.keys) if (k && k.kind === 'folder' && k.folder) walk(k.folder);
        }
      };
      for (const prof of cfg.profiles) walk(prof.root);
      return n;
    } catch { return 1; }
  }

  // A preset is { id, name, profile, createdAt } where `profile` is a DeckModel
  // profile object. Stored locally and backed up to the server alongside the
  // configs (it rides the same rev / last-writer-wins).
  function readPresets() {
    try { const a = JSON.parse(localStorage.getItem(PRESETS_KEY)); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }

  function listProfilePresets() { return readPresets(); }

  // Count placed keys in a single profile's tree (0 = empty placeholder).
  function countProfileKeys(prof) {
    try {
      let n = 0;
      const walk = (folder) => {
        for (const page of folder.pages) {
          n += page.keys.filter(Boolean).length;
          for (const k of page.keys) if (k && k.kind === 'folder' && k.folder) walk(k.folder);
        }
      };
      walk(prof.root);
      return n;
    } catch { return 0; }
  }

  // The deck instances that actually exist on the dashboard right now: the base
  // 'deck' plus any copy still placed in the layout. A removed deck tile can leave
  // its config behind (a copy that missed forgetInstance), and its profiles then
  // leaked into the profile/share pickers as "ghosts" — this is the gate that keeps
  // them out. Returns null when the layout isn't known yet, so nothing live is ever
  // hidden (fail-open).
  function liveInstanceSet() {
    try {
      if (typeof getDashboardLayout !== 'function') return null;
      const layout = getDashboardLayout();
      if (!layout || !Array.isArray(layout.copies)) return null;
      return new Set(layout.copies.map((c) => c && c.id).filter(Boolean));
    } catch { return null; }
  }

  function isLiveInstance(id, live) {
    if (String(id).indexOf('~') < 0) return true;   // the primary 'deck' is always live
    return live ? live.has(id) : true;              // unknown layout → treat as live
  }

  // Stored COPY configs no longer placed anywhere on the dashboard — leftovers from
  // removed deck tiles. Empty [] when the layout isn't known (never guess).
  function listOrphanInstances() {
    const live = liveInstanceSet();
    if (!live) return [];
    return Object.keys(readStore()).filter((id) => id.indexOf('~') >= 0 && !live.has(id));
  }

  // Profiles that live on OTHER deck instances, offered in the profile menu as one-tap
  // "copy into this deck" sources — so a newly added (independent) deck can pull in a
  // profile already built elsewhere without first saving it as a preset. Empty
  // placeholder profiles are skipped. Returns [{ instanceId, profileId, name, keys }].
  //
  // Deliberately NOT deduped, by name or otherwise — it used to be, and that was the
  // bug. Two dedupes were in the way of the one case the list exists for:
  //
  //   · against THIS deck: a source was dropped if a profile here already had its
  //     name. Someone duplicating a page, landing an obsolete "Nocturne Control" on
  //     the new Deck, then coming back for the real one found nothing — the current
  //     profile was hidden precisely BECAUSE the stale namesake was sitting next to
  //     it. With one candidate, the whole section vanished and the answer read as
  //     "this feature doesn't work".
  //   · across decks: only the first profile with a given name was offered, so which
  //     of three same-named profiles you were given came down to key order.
  //
  // listOrphanProfiles already learned this and says so in its own comment; the
  // reasoning was never specific to removed decks. So every non-empty profile is
  // listed, and the key count rides along as the thing that tells namesakes apart.
  function listOtherDeckProfiles(instanceId) {
    const M = window.DeckModel;
    const all = readStore();
    const out = [];
    const live = liveInstanceSet();
    for (const otherId of Object.keys(all)) {
      if (otherId === instanceId) continue;
      if (!isLiveInstance(otherId, live)) continue;   // hide profiles from removed decks
      let cfg; try { cfg = M.normalizeDeckConfig(all[otherId]); } catch { continue; }
      for (const prof of (cfg.profiles || [])) {
        const keys = countProfileKeys(prof);
        if (keys === 0) continue;   // an empty placeholder is not worth offering
        out.push({ instanceId: otherId, profileId: prof.id, name: prof.name, keys });
      }
    }
    return out;
  }

  // The profiles sitting in configs whose deck tile is gone — and the reason this
  // list exists at all.
  //
  // Three rules had grown up around orphaned configs, and together they made a
  // trap. pruneOrphanEmptyConfigs deletes only EMPTY orphans, on the stated
  // principle that "data is surfaced, not silently deleted". isLiveInstance then
  // hides every orphan's profiles from the profile menu and the share picker, so
  // a removed deck cannot leave ghosts behind. And the profile menu offered
  // exactly one thing to do about them: a 🗑 button that throws them away.
  //
  // So keys the app had promised to keep were kept, hidden, and offered only for
  // deletion. Reported after a dashboard was replaced by the factory default: the
  // deck tiles went with it, and every key on them became unreachable while still
  // sitting in deck.json. This is the half that was missing — the same one-tap
  // copy that already exists for a profile on another deck, pointed at the decks
  // that are no longer there.
  //
  // Deliberately NOT deduped by name against this deck, unlike listOtherDeckProfiles:
  // the reason someone is looking here is that a profile with the name they
  // remember is present but empty, and hiding the real one behind the empty
  // namesake is the exact failure being fixed. The key count is carried so the
  // rows can say which is which.
  function listOrphanProfiles() {
    const M = window.DeckModel;
    const all = readStore();
    const out = [];
    for (const id of listOrphanInstances()) {
      let cfg; try { cfg = M.normalizeDeckConfig(all[id]); } catch { continue; }
      for (const prof of (cfg.profiles || [])) {
        const keys = countProfileKeys(prof);
        if (keys > 0) out.push({ instanceId: id, profileId: prof.id, name: prof.name, keys });
      }
    }
    return out;
  }

  // How many keys the 🗑 button is about to destroy. The confirmation used to
  // describe what it removed as leftovers, which is true of the config and false
  // of what is in it.
  function orphanKeyCount() {
    return listOrphanProfiles().reduce((n, p) => n + p.keys, 0);
  }

  // The deck tiles currently on the dashboard, as import targets.
  function listDeckTargets() {
    return deckInstances().map(({ instanceId }, i) => {
      const cfg = getConfig(instanceId);
      return { instanceId, label: 'Deck ' + (i + 1), profiles: cfg.profiles.length };
    });
  }

  // Every non-empty profile across every stored deck (for the share picker).
  function listAllDeckProfiles() {
    const M = window.DeckModel;
    const all = readStore();
    const out = [];
    const live = liveInstanceSet();
    for (const id of Object.keys(all)) {
      if (!isLiveInstance(id, live)) continue;   // never surface a removed deck's profiles
      let cfg; try { cfg = M.normalizeDeckConfig(all[id]); } catch { continue; }
      for (const prof of (cfg.profiles || [])) {
        const keys = countProfileKeys(prof);
        if (keys > 0) out.push({ instanceId: id, profileId: prof.id, name: prof.name, keys, imported: prof.imported === true, installId: prof.installId || '' });
      }
    }
    return out;
  }

  // Deep-cloned profile object for export (PresetShare sanitizes + encodes it).
  function getProfileTemplate(instanceId, profileId) {
    const cfg = durableConfig(instanceId);
    const M = window.DeckModel;
    const prof = M.getProfile(cfg, profileId);
    if (!prof) return prof;
    // Snapshot the effective presentation so importing this profile never depends
    // on the receiver's Deck defaults. Imported third-party artwork stays home.
    const clone = JSON.parse(JSON.stringify(prof));
    const effective = M.effectiveDeckLook(cfg, profileId);
    clone.look = {
      capStyle: effective.capStyle,
      keyShape: effective.keyShape,
      plate: effective.plate,
      wellImage: (effective.wellImage && effective.wellImage.imported !== true) ? effective.wellImage : null,
      mediaStyle: (effective.mediaStyle && effective.mediaStyle.imported !== true) ? effective.mediaStyle : null,
    };
    return clone;
  }

  // Imported resource inventory + receipt-checked removal used by the content
  // manager. A missing/old receipt may only touch legacy `imported` entries;
  // a normal receipt must match the profile/preset installId exactly.
  function listImportedResources() {
    const profiles = [];
    const M = window.DeckModel;
    const all = readStore();
    for (const instanceId of Object.keys(all)) {
      let cfg; try { cfg = M.normalizeDeckConfig(all[instanceId]); } catch { continue; }
      for (const profile of (cfg.profiles || [])) {
        if (profile.imported === true) profiles.push({ instanceId, profileId: profile.id, installId: profile.installId || '' });
      }
    }
    const presets = readPresets()
      .filter(p => p && p.profile && p.profile.imported === true)
      .map(p => ({ presetId: p.id, installId: p.installId || p.profile.installId || '' }));
    return { profiles, presets };
  }

  function readKeyPresets() {
    try { const a = JSON.parse(localStorage.getItem(KEYPRESETS_KEY)); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }

  function listKeyPresets() { return readKeyPresets(); }

  // Every deck tile in the DOM with its per-instance id (the base tile has none;
  // duplicated copies carry data-dashboard-instance="deck~xxxx").
  function deckInstances() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="deck"]'))
      .map((tile) => ({ tile, instanceId: tile.getAttribute('data-dashboard-instance') || 'deck' }));
  }

  window.DeckStoreReads = {
    STORE_KEY, PRESETS_KEY, KEYPRESETS_KEY, displayConfigs, readStore, durableConfig, getConfig,
    countConfigKeys, readPresets, listProfilePresets, countProfileKeys, listOrphanInstances,
    listOtherDeckProfiles, listOrphanProfiles, orphanKeyCount, listDeckTargets, listAllDeckProfiles,
    getProfileTemplate, listImportedResources, readKeyPresets, listKeyPresets, deckInstances,
  };
})();
