// What the engine answers about the smart home: the state of Home Assistant, its entities,
// dashboards and cameras, a test and a service call, the entities the Deck watches, a history a
// widget asks for, and UniFi Protect.

const { readBody } = require('../http/read-body.js');
const { sdkFeatureEnabled, sdkGrantsFor } = require('../widget-sdk/grants.js');
const { sdkTileGate } = require('../widget-sdk/tile-cache.js');
const { normalizeHistoryRequest } = require('../actions/home-assistant-query.js');
const { HA_ENTITY_ID_RE, HA_DECK_WATCH_MAX, HA_DECK_WATCH_CLIENTS_MAX } = require('./limits.js');
const { _haDeckWatchClients, haDeckWatchUnion } = require('./deck-watch.js');
const { haSameDestination, createHomeAssistant } = require('../actions/home-assistant.js');
const { withHubSettingsLock } = require('../settings/write-lock.js');
const { hub } = require('../settings/current.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const remoteActions = require('../remote-actions.js');
const { unifiSameDestination, createUnifiProtect } = require('../actions/unifi.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/homeassistant/state': async (_req, _res, { json, err500 }, { buildHaState }) => {
    // Compact snapshot of the user's selected entities + connection flag (the same
    // shape the SSE `homeassistant` event pushes). Used as a fallback/first paint.
    try { json(await buildHaState()); }
    catch (e) { err500(e.message); }
  },

  'POST /stream/homeassistant/query': async (req, _res, { json }, { haQuery, readHubSettings }) => {
    // Home Assistant READS for SDK widgets: an entity's recent history, one
    // camera frame, or a media player's cover art. Gated per package on the `homeassistant` stream grant, and
    // only for entities the user already selected (the same ones the stream
    // shows that widget) — a widget can't name a lock, a person or a camera the
    // user never chose. POST JSON, so the loopback Origin layer covers it.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const pkgId = String(body.pkg || '');
      if (!sdkFeatureEnabled() || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(pkgId)) { json({ ok: false, error: 'not_allowed' }); return; }
      if (!sdkGrantsFor(pkgId).streams.includes('homeassistant')) { json({ ok: false, error: 'not_allowed' }); return; }
      const s = (await readHubSettings().catch(() => null)) || {};
      const ha = (s && s.homeAssistant) || {};
      if (!(ha.url && ha.token)) { json({ ok: false, error: 'not_configured' }); return; }
      const allowed = [].concat(ha.entities || [], ha.energyEntities || []);
      const p = (body.params && typeof body.params === 'object') ? body.params : {};
      const release = sdkTileGate(pkgId, 'tile');
      if (!release) { json({ ok: false, error: 'rate_limited' }); return; }
      try {
        if (body.op === 'history') {
          const q = normalizeHistoryRequest(p.ids, p.hours, allowed);
          json(q.error ? { ok: false, error: q.error } : Object.assign(await haQuery.history(q.ids, q.hours), { skipped: q.skipped }));
        } else if (body.op === 'camera') {
          json(await haQuery.cameraFrame(p.id, allowed));
        } else if (body.op === 'artwork') {
          json(await haQuery.artwork(p.id, allowed));
        } else {
          json({ ok: false, error: 'bad_op' });
        }
      } finally { release(); }
    } catch (e) {
      // A fixed code: a failed HA call's message can carry the HA host and port.
      json({ ok: false, error: e instanceof SyntaxError ? 'bad_json' : 'ha_failed' });
    }
  },

  'POST /ha/deck-watch': async (req, _res, { json }, { broadcastHaDeckStates }) => {
    // A SURFACE tells the server which HA entities its deck keys are bound to;
    // the shared watch then includes the UNION across surfaces in the coalesced
    // `ha_states` broadcasts (per-client sets — a popup showing a narrow folder
    // can't clobber the dashboard's list). POST-only JSON → covered by the
    // loopback Origin layer; client id + entity ids re-validated.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const client = String(body.client || '').trim();
      if (!/^[a-z0-9]{4,24}$/.test(client)) { json({ ok: false, error: 'bad_client' }); return; }
      const raw = Array.isArray(body.entities) ? body.entities : [];
      const ids = [];
      for (const item of raw) {
        const id = String(item == null ? '' : item).trim().toLowerCase();
        if (HA_ENTITY_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
        if (ids.length >= HA_DECK_WATCH_MAX) break;
      }
      if (!ids.length) {
        _haDeckWatchClients.delete(client);
      } else {
        // Bounded: a burst of new client ids evicts the stalest entry first.
        if (!_haDeckWatchClients.has(client) && _haDeckWatchClients.size >= HA_DECK_WATCH_CLIENTS_MAX) {
          let oldest = null;
          for (const [k, v] of _haDeckWatchClients) { if (!oldest || v.at < oldest.at) oldest = { k, at: v.at }; }
          if (oldest) _haDeckWatchClients.delete(oldest.k);
        }
        _haDeckWatchClients.set(client, { ids, at: Date.now() });
      }
      // Seed immediately so freshly-bound keys paint without waiting for the
      // next state_changed. FORCED past the change guard: the posting client
      // needs the snapshot even when it matches the last broadcast.
      try { broadcastHaDeckStates(true); } catch (e) { /* ignore */ }
      json({ ok: true, watching: haDeckWatchUnion().length });
    } catch (e) { json({ ok: false, error: (e && e.message) || 'bad_request' }); }
  },

  'GET /api/homeassistant/entities': async (_req, _res, { json }, { deckHa, readHubSettings }) => {
    // Full compact entity list for the Settings device picker. Opens a live
    // connection on demand (idle-closes afterwards). Never leaks the token.
    try {
      const s = (await readHubSettings().catch(() => null)) || {};
      const ha = (s && s.homeAssistant) || {};
      if (!(ha.url && ha.token)) { json({ ok: false, error: 'not_configured' }); return; }
      const entities = await deckHa.listEntities();
      json({ ok: true, entities });
    } catch (e) {
      // A fixed code: a failed HA call's message can carry the HA host and port.
      json({ ok: false, error: e instanceof SyntaxError ? 'bad_json' : 'ha_failed' });
    }
  },

  'GET /api/homeassistant/dashboards': async (_req, _res, { json }, { deckHa, readHubSettings }) => {
    // Settings → Smart Home → "Add as a tile": the user's HA dashboards (Overview
    // first). Read-only, opened on demand like /entities; never leaks the token.
    try {
      const s = (await readHubSettings().catch(() => null)) || {};
      const ha = (s && s.homeAssistant) || {};
      if (!(ha.url && ha.token)) { json({ ok: false, error: 'not_configured' }); return; }
      json({ ok: true, dashboards: await deckHa.listDashboards() });
    } catch (e) {
      json({ ok: false, error: 'ha_failed' });   // fixed code: the message can carry the HA host
    }
  },

  'POST /api/homeassistant/test': async (req, _res, { json }, { readHubSettings, refreshHaWatch, writeHubSettings }) => {
    // Settings "Connect" button: verify the URL + token by opening one connection.
    // Reads the just-typed url/token from the body so it works before a full save.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const prev = (await readHubSettings().catch(() => null)) || {};
      const prevHa = (prev && prev.homeAssistant) || {};
      const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : prevHa.url;
      // Empty/omitted token in the body → fall back to the saved one (write-only
      // field), but only for the server it was saved for. The URL comes from the
      // request, so without this check any page that can POST here could point
      // the probe at its own host and receive the long-lived token. A new URL
      // needs its token typed alongside it, which is what the Connect form sends.
      const typedToken = typeof body.token === 'string' && body.token ? body.token : '';
      const token = typedToken || (haSameDestination(url, prevHa.url) ? prevHa.token : '');
      const probe = createHomeAssistant(async () => ({ baseUrl: url, token }));
      const r = await probe.test();
      // On success, return the entity list from the SAME already-seeded probe, so
      // the Settings picker can populate immediately — the persisted settings save
      // is debounced, so a follow-up GET /entities could still read the old config.
      let entities = [];
      if (r && r.ok) {
        entities = await probe.listEntities().catch(() => []);
        // Persist url+token straight away so a green "Connected" ALWAYS means the
        // token reached settings.json. The client's own save is debounced +
        // fire-and-forget and can be lost to a hydrate/reconnect race (the redacted
        // server copy overwriting the just-typed token before it lands), which
        // strands the tile on "Connect Home Assistant" (configured=false) even
        // though the test passed. Writing here closes that window; the client mirror
        // save still runs and is reconciled by preserveHaToken. Read fail-closed: a
        // real read error must NOT lead to writing a defaults-only object over the
        // user's config (readHubSettings maps ENOENT → null on a fresh install).
        try {
          await withHubSettingsLock(async () => {       // serialized with every other settings writer
            const base = await readHubSettings();
            const cur = (base && typeof base === 'object') ? base : {};
            const curHa = (cur.homeAssistant && typeof cur.homeAssistant === 'object') ? cur.homeAssistant : {};
            const next = { ...cur, homeAssistant: { ...curHa, url, token }, rev: (Number(cur.rev) || 0) + 1 };
            const saved = await writeHubSettings(next);
            hub.settings = saved;
            refreshHaWatch();                              // open the live socket now that we're configured
            broadcastSSE('settings', { rev: saved.rev });  // other open surfaces adopt the saved token
          });
        } catch (e) { /* non-fatal: the client's debounced save remains the fallback */ }
      }
      try { probe.close(); } catch (e) { /* ignore */ }
      json(Object.assign({ entities }, r));
    } catch (e) {
      // A fixed code: a failed HA call's message can carry the HA host and port.
      json({ ok: false, error: e instanceof SyntaxError ? 'bad_json' : 'ha_failed' });
    }
  },

  'POST /api/homeassistant/service': async (req, _res, { json, isRemote }, { deckHa }) => {
    // Call a Home Assistant service (tile controls). POST-only, so the loopback
    // Origin/Sec-Fetch checks in isAllowedRequest guard it from cross-site drive-by.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const target = body.entityId ? { entity_id: String(body.entityId) } : null;
      const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {};
      if (isRemote && !remoteActions.remoteMayCallHa(body.domain, body.service, body.entityId, data)) {
        json({ ok: false, error: 'needs_pc' }); return;
      }
      json(await deckHa.callService(String(body.domain || ''), String(body.service || ''), target, data));
    } catch (e) {
      // A fixed code: a failed HA call's message can carry the HA host and port.
      json({ ok: false, error: e instanceof SyntaxError ? 'bad_json' : 'ha_failed' });
    }
  },

  'GET /api/unifiprotect/state': async (_req, _res, { json, err500 }, { deckUnifi, readHubSettings }) => {
    // First paint + periodic status poll for the Cameras tile: whether UniFi
    // Protect is configured and the compact camera list (id/name/connected). Opens
    // a login on demand (short-cached), never leaks the password.
    try {
      const s = (await readHubSettings().catch(() => null)) || {};
      const u = (s && s.unifi) || {};
      const configured = !!(u.host && u.username && u.password);
      if (!configured) { json({ configured: false, cameras: [] }); return; }
      try { json({ configured: true, cameras: await deckUnifi.cameras() }); }
      catch (e) { json({ configured: true, cameras: [], error: (e && e.message) || 'unifi_failed' }); }
    } catch (e) { err500(e.message); }
  },

  'GET /api/ha/cameras': async (_req, _res, { json, err500 }, { deckHa, readHubSettings }) => {
    // First paint + periodic status poll for the Cameras tile's Home Assistant
    // source: whether HA is configured and the compact camera list. Opens a live
    // WS on demand (idle-closes afterwards), never leaks the token. Mirrors the
    // /api/unifiprotect/state shape so the tile can merge both sources uniformly.
    try {
      const s = (await readHubSettings().catch(() => null)) || {};
      const ha = (s && s.homeAssistant) || {};
      const configured = !!(ha.url && ha.token);
      if (!configured) { json({ configured: false, cameras: [] }); return; }
      try { json({ configured: true, cameras: await deckHa.cameras() }); }
      catch (e) { json({ configured: true, cameras: [], error: (e && e.message) || 'ha_failed' }); }
    } catch (e) { err500(e.message); }
  },

  'POST /api/unifiprotect/test': async (req, _res, { json }, { readHubSettings }) => {
    // Settings "Connect" button: verify host + credentials by logging in once and
    // listing cameras. Reads the just-typed values from the body so it works before
    // a full save; an empty/omitted password falls back to the saved one.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const prev = (await readHubSettings().catch(() => null)) || {};
      const prevU = (prev && prev.unifi) || {};
      const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : prevU.host;
      const username = typeof body.username === 'string' && body.username.trim() ? body.username.trim() : prevU.username;
      // The saved password is reused only for the console + login it was saved
      // for; host and username come from the request, so a changed one must
      // arrive with its own password (see the Home Assistant test route).
      const typedPassword = typeof body.password === 'string' && body.password ? body.password : '';
      const password = typedPassword || (unifiSameDestination({ host, username }, prevU) ? prevU.password : '');
      const probe = createUnifiProtect(async () => ({ host, username, password }));
      const r = await probe.test();
      try { probe.destroy(); } catch (e) { /* ignore */ }   // free its keep-alive sockets to the console
      json(r);
    } catch (e) { json({ ok: false, error: (e && e.message) || 'unifi_failed' }); }
  },
};

module.exports = { branches };
