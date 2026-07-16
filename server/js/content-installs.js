'use strict';
// Persistent receipt for imported Xenon content. The receipt stores only the
// generated ids of installed resources, never the imported payload itself.
(function initContentInstalls(root) {
  const INSTALL_ID_RE = /^xi_[a-z0-9]{8,32}$/;
  const RESOURCE_ID_RE = /^[A-Za-z0-9_~:-][A-Za-z0-9._~:-]{0,79}$/;
  const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
  // Icon packs share the SDK-package id shape (folder name = pack id).
  const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
  const FONT_URL_RE = /^\/uploads\/[A-Za-z0-9._-]+\.(?:woff2?|ttf|otf)$/i;
  // Kind list mirrors PRESET_KINDS in preset-share.js (and the catalog kind
  // lists in community-catalog.js + docs) — keep them in step.
  const KINDS = Object.freeze(['theme', 'page', 'deck', 'bundle', 'bg', 'widget', 'ambient', 'ambient-layout', 'icons', 'sounds']);
  const MAX_INSTALLS = 64;
  const MAX_RESOURCE_IDS = 64;

  function cleanText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  function cleanIds(value, test) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const raw of value) {
      const id = cleanText(raw, 80);
      if (!id || !test.test(id) || out.includes(id)) continue;
      out.push(id);
      if (out.length >= MAX_RESOURCE_IDS) break;
    }
    return out;
  }

  function normalizeDeckProfiles(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const instanceId = cleanText(raw.instanceId, 80);
      const profileId = cleanText(raw.profileId, 80);
      if (!RESOURCE_ID_RE.test(instanceId) || !RESOURCE_ID_RE.test(profileId)) continue;
      const key = instanceId + '\n' + profileId;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ instanceId, profileId });
      if (out.length >= MAX_RESOURCE_IDS) break;
    }
    return out;
  }

  function normalizeResources(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      themeIds: cleanIds(source.themeIds, RESOURCE_ID_RE),
      pagePresetIds: cleanIds(source.pagePresetIds, RESOURCE_ID_RE),
      pageIds: cleanIds(source.pageIds, RESOURCE_ID_RE),
      deckProfiles: normalizeDeckProfiles(source.deckProfiles),
      deckPresetIds: cleanIds(source.deckPresetIds, RESOURCE_ID_RE),
      widgetIds: cleanIds(source.widgetIds, WIDGET_ID_RE),
      ambientSceneIds: cleanIds(source.ambientSceneIds, RESOURCE_ID_RE),
      iconPackIds: cleanIds(source.iconPackIds, PACK_ID_RE),
      soundPackIds: cleanIds(source.soundPackIds, PACK_ID_RE),
      fontUrls: cleanIds(source.fontUrls, FONT_URL_RE),
      background: source.background === true,
    };
  }

  function resourceCount(resources) {
    const r = normalizeResources(resources);
    return r.themeIds.length + r.pagePresetIds.length + r.pageIds.length
      + r.deckProfiles.length + r.deckPresetIds.length + r.widgetIds.length
      + r.ambientSceneIds.length + r.iconPackIds.length + r.soundPackIds.length
      + r.fontUrls.length + (r.background ? 1 : 0);
  }

  function normalizeContentInstalls(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    // Receipts are appended chronologically. Walk backwards so a long-lived
    // install keeps the most recent imports when the bounded store fills up.
    for (let index = value.length - 1; index >= 0; index--) {
      const raw = value[index];
      if (out.length >= MAX_INSTALLS) break;
      if (!raw || typeof raw !== 'object') continue;
      const id = cleanText(raw.id, 40);
      if (!INSTALL_ID_RE.test(id) || seen.has(id)) continue;
      const resources = normalizeResources(raw.resources);
      if (!resourceCount(resources)) continue;
      seen.add(id);
      const record = {
        id,
        name: cleanText(raw.name, 60),
        kind: KINDS.includes(raw.kind) ? raw.kind : 'bundle',
        installedAt: Number.isFinite(Number(raw.installedAt)) ? Math.max(0, Math.floor(Number(raw.installedAt))) : 0,
        source: raw.source === 'catalog' ? 'catalog' : 'import',
        resources,
      };
      const sourceId = cleanText(raw.sourceId, 80);
      if (sourceId && RESOURCE_ID_RE.test(sourceId)) record.sourceId = sourceId;
      // Catalog entry version at install time — the receipts half of the
      // update join (community-gallery.js findUpdates). Fail-closed shape:
      // junk never survives, so it can never produce a false update badge.
      const sourceVersion = cleanText(raw.sourceVersion, 20);
      if (sourceVersion && /^[0-9]+(\.[0-9]+)*$/.test(sourceVersion)) record.sourceVersion = sourceVersion;
      out.unshift(record);
    }
    return out;
  }

  const api = {
    INSTALL_ID_RE,
    KINDS,
    MAX_INSTALLS,
    normalizeResources,
    normalizeContentInstalls,
    resourceCount,
  };
  if (root && typeof root === 'object') root.ContentInstalls = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
