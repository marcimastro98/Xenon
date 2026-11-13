// What the engine answers about the weather, and the weather setup saved.

const { withHubSettingsLock } = require('../settings/write-lock.js');
const { readBody } = require('../http/read-body.js');
const { nextSettingsRev } = require('../settings-rev.js');
const { hub } = require('../settings/current.js');
const { broadcastSSE } = require('../http/sse-clients.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /weather': async (_req, _res, { json, err500, urlObj }, { getWeather }) => {
    try {
      const requestedWeather = urlObj.searchParams.has('mode') || urlObj.searchParams.has('city')
        ? { mode: urlObj.searchParams.get('mode'), city: urlObj.searchParams.get('city') }
        : null;
      json(await getWeather(urlObj.searchParams.get('lang') || 'en', requestedWeather));
    }
    catch (e) { err500(e.message); }
  },

  'POST /api/weather/config': async (req, _res, { json, err500 }, { readHubSettingsForUpdate, writeHubSettings }) => {
    // Weather location/config, edited from Settings on any surface. It is
    // deliberately NOT persisted through the whole-settings blob: that transport
    // is shared with high-frequency automatic saves (a Vitals/Bit heartbeat) and
    // the unload beacon, either of which — coming from a surface that still holds
    // the OLD location — would clobber a change just made elsewhere via
    // last-writer-wins (the "XENON stays on the wrong weather location" bug,
    // GitHub #109). Persisted like the stocks watchlist: a dedicated writer the
    // generic POST /settings then preserves (keep-prev). Unlike the watchlist it
    // also bumps the settings rev and broadcasts, because a peer surface only
    // refetches the new location once its settings hydrate updates its own
    // hubSettings.weather (GitHub #72). writeHubSettings normalizes the whole
    // object, so the incoming weather block is validated server-side here.
    try {
      await withHubSettingsLock(async () => {          // serialized with every other settings writer
      const body = JSON.parse(await readBody(req));
      const cur = await readHubSettingsForUpdate();
      const nextWeather = (body && body.weather && typeof body.weather === 'object') ? body.weather : {};
      // Exact same monotonic rule as POST /settings, through the shared helper:
      // re-deriving the rev from the stored copy alone left this endpoint BELOW
      // the client's rev (the city field bumps it per keystroke, only the last
      // debounced save reaches us), and a broadcast under a surface's own rev is
      // ignored by its hydrate — so that surface stopped adopting a location set
      // elsewhere (the "browser keeps auto location" residual of GitHub #109).
      const rev = nextSettingsRev(cur.rev, body && body.rev);
      const saved = await writeHubSettings({ ...cur, weather: { ...(cur.weather || {}), ...nextWeather }, rev });
      hub.settings = saved;
      broadcastSSE('settings', { rev: saved.rev });   // peers re-hydrate → refetch the new location
      json({ ok: true, weather: saved.weather, rev: saved.rev });
      });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
