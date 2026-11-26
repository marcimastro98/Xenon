'use strict';
// The routes of the person's own Bit, made for one store and one hatch
// (routes.js wires the real ones, the tests their own). Who may call each one:
// routes.js.

const Model = require('./model.js');

const MAX_BODY_BYTES = 4 * 1024;

/**
 * @param {{ store: import('./store.js').BitStore, hatch: { hatch: () => Promise<object> }, founder: (fresh: boolean) => Promise<boolean>,
 *   publish?: { set: (on: boolean) => Promise<{ ok: boolean, error?: string }>, refresh: () => Promise<boolean> },
 *   keep?: { claim: (id: string) => Promise<any>, shop: (id: string, consent?: string) => Promise<any>, perk: (id: string) => Promise<any> },
 *   items?: { ready: () => Promise<void>, refresh: () => Promise<boolean> },
 *   settings?: () => object, changed?: (bit: object) => void }} deps
 */
function createRoutes({ store, hatch, founder, publish = NO_PUBLISH, keep = NO_KEEP, items = NO_ITEMS, settings = () => ({}), changed = (_bit) => {} }) {
  // The first time the app asks, the egg is written down, with whether this
  // install had Xenon before (hands.FRESH_INSTALL: the data folder was empty
  // when this engine started) and where the Vitals' Bit already lived.
  async function current(hands) {
    if (!store.onDisk()) {
      await store.create(await founder(!!(hands?.FRESH_INSTALL)), { prefs: prefsFromVitals(settings()) });
    }
    return store.ready();
  }

  const view = (model) => ({ ok: true, bit: Model.view(model, new Date()) });

  // Every surface hears a change (the 'bit' event), the one that made it too.
  async function told() {
    const answer = view(await store.ready());
    changed(answer.bit);
    return answer;
  }

  async function readJson(req, readBody) {
    try {
      const b = JSON.parse(await readBody(req, MAX_BODY_BYTES));
      return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
    } catch { return null; }
  }

  // A change: the step answers { model } | { error } | null, as in model.js. A change the
  // site shows (shown: true) goes to the hub too, without waiting for it.
  function changing(stepOf, { onSite = false } = {}) {
    return async (req, _res, { json, readBody }, hands) => {
      const body = await readJson(req, readBody);
      if (!body) { json({ ok: false, error: 'bad_request' }); return; }
      let out;
      try {
        await items.ready(); // an item from the hub goes on only once its list is read
        await current(hands);
        out = await store.update((m) => stepOf(m, body));
      } catch { json({ ok: false, error: 'write_failed' }); return; }
      if (out?.error) { json({ ok: false, error: out.error, ...(out.perk ? { perk: out.perk } : {}) }); return; }
      if (onSite && !out?.unchanged) publish.refresh().then((off) => off && told(), () => {});
      json(out?.unchanged ? view(await store.ready()) : await told());
    };
  }

  // An item or an extra kept through the hub (keep.js): its answer, with the Bit as it is now.
  function keeping(ask, field = 'item') {
    return async (req, _res, { json, readBody }, hands) => {
      const body = await readJson(req, readBody);
      if (!body || typeof body[field] !== 'string') { json({ ok: false, error: 'bad_request' }); return; }
      let out;
      try {
        await items.ready();
        await current(hands);
        out = await ask(body);
      } catch { json({ ok: false, error: 'write_failed' }); return; }
      json(out.ok ? { ...(await told()), ...out } : { ...view(await store.ready()), ...out });
    };
  }

  return {
    'GET /api/bit': async (_req, _res, { json }, hands) => {
      try {
        await items.ready();
        json(view(await current(hands)));
      } catch { json({ ok: false, error: 'read_failed' }); return; }
      // The hub's items (items.js), asked at most every few hours: a new one reaches every surface.
      items.refresh().then((news) => news && told(), () => {});
    },
    'POST /api/bit/hatch': async (_req, _res, { json }, hands) => {
      let out;
      try {
        await current(hands);
        out = await hatch.hatch();
      } catch { json({ ok: false, error: 'write_failed' }); return; }
      if (!out.ok) { json({ ok: false, error: out.error, retryAt: out.retryAt }); return; }
      json(out.already ? view(await store.ready()) : await told());
    },
    'POST /api/bit/wear': changing((m, body) => Model.wear(m, body.worn), { onSite: true }),
    'POST /api/bit/name': changing((m, body) => Model.rename(m, body.name), { onSite: true }),
    'POST /api/bit/prefs': changing((m, body) => Model.setPrefs(m, body)),
    'POST /api/bit/claim': keeping((body) => keep.claim(body.item)),
    'POST /api/bit/buy': keeping((body) => keep.shop(body.item, typeof body.consent === 'string' ? body.consent : undefined)),
    'POST /api/bit/perk': keeping((body) => keep.perk(body.perk), 'perk'),
    'POST /api/bit/publish': async (req, _res, { json, readBody }, hands) => {
      const body = await readJson(req, readBody);
      if (typeof body?.public !== 'boolean') { json({ ok: false, error: 'bad_request' }); return; }
      let out;
      try {
        await current(hands);
        out = await publish.set(body.public);
      } catch { json({ ok: false, error: 'write_failed' }); return; }
      json(out.ok ? await told() : { ...view(await store.ready()), ok: false, error: out.error });
    },
  };
}

// Tests and a store with no hub: nothing is kept through it.
const NO_KEEP = Object.freeze({ claim: async () => ({ ok: false, error: 'network' }), shop: async () => ({ ok: false, error: 'network' }), perk: async () => ({ ok: false, error: 'network' }) });
// Tests and a store with no hub: only the items of the code.
const NO_ITEMS = Object.freeze({ ready: async () => {}, refresh: async () => false });
// Tests and a store with no hub: nothing is ever shown.
const NO_PUBLISH = Object.freeze({ set: async () => ({ ok: false, error: 'network' }), refresh: async () => false });

// The Vitals' Bit (vitals.pet) becomes the companion: one Bit on screen, where it
// already lived. Its nagging stays under vitals.pet, as it was.
function prefsFromVitals(settings) {
  const pet = settings?.vitals?.pet;
  if (pet?.enabled !== true) return Model.DEFAULT_PREFS;
  const place = { floating: 'corner', topbar: 'topbar', both: 'both' }[pet.position] || 'corner';
  return { ...Model.DEFAULT_PREFS, place, sounds: pet.sounds !== false };
}

module.exports = { createRoutes, prefsFromVitals, MAX_BODY_BYTES };
