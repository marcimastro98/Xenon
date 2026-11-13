// What the engine answers for the football tile, and what it saves for the tickers: the teams,
// the news feeds and the stocks watchlist.

const { withHubSettingsLock } = require('../settings/write-lock.js');
const { readBody } = require('../http/read-body.js');
const stocks = require('../stocks.js');
const { hub } = require('../settings/current.js');
const { _footballSettings } = require('./feed-settings.js');
const football = require('../football.js');
const news = require('../news.js');
const { refreshNews } = require('./news-refresh.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /api/stocks/watchlist': async (req, res, { json, err500 }, { readHubSettingsForUpdate, refreshStocks, writeHubSettings }) => {
    // Add / remove a favorite symbol (or replace the whole list). Persisted in
    // settings.stocks.watchlist via the atomic writer, then a refresh is kicked.
    try {
      await withHubSettingsLock(async () => {          // serialized with every other settings writer
      const body = JSON.parse(await readBody(req));
      const cur = await readHubSettingsForUpdate();
      let wl = Array.isArray(cur.stocks && cur.stocks.watchlist) ? cur.stocks.watchlist.slice() : [];
      const action = String(body.action || '').toLowerCase();
      if (action === 'set' && Array.isArray(body.watchlist)) {
        // Through the same normalizer 'add' effectively goes through, rather
        // than storing the posted array as it arrives: 'set' is what the
        // widget's drag-to-reorder posts, so this is now a user-facing path and
        // has to clean symbols, cap names and drop duplicates like every other.
        wl = stocks.normalizeWatchlist(body.watchlist);
        if (!wl.length) { res.writeHead(400); res.end('bad watchlist'); return; }
      } else if (action === 'remove') {
        const sym = stocks.cleanSymbol(body.symbol);
        wl = wl.filter(w => w.symbol !== sym);
      } else { // add (default)
        const sym = stocks.cleanSymbol(body.symbol);
        if (!sym) { res.writeHead(400); res.end('bad symbol'); return; }
        if (!wl.some(w => w.symbol === sym)) wl.push({ symbol: sym, name: String(body.name || '').slice(0, 60) });
      }
      const next = { ...cur, stocks: { ...cur.stocks, watchlist: wl } };
      const saved = await writeHubSettings(next);
      hub.settings = saved;
      refreshStocks().catch(() => {});
      json({ ok: true, watchlist: saved.stocks.watchlist });
      });
    } catch (e) { err500(e.message); }
  },

  'GET /api/football': async (_req, _res, { json, err500, urlObj }, { _footballPayload, _loadFootballInfo, refreshFootball }) => {
    // Current fixtures/results for the favorite teams (+ the config the widget needs).
    try {
      if (urlObj.searchParams.has('refresh')) await refreshFootball();
      const cfg = _footballSettings();
      // A cold seed has no identity on disk yet; load it (cheap, no network) so
      // the very first paint already has crests instead of letter initials.
      await _loadFootballInfo();
      json({ ..._footballPayload(), favorites: cfg.teams, tile: cfg.tile });
    } catch (e) { err500(e.message); }
  },

  'POST /api/football/teams': async (req, res, { json, err500 }, { readHubSettingsForUpdate, refreshFootball, writeHubSettings }) => {
    // Add / remove a favorite team (or replace the whole list). Persisted in
    // settings.football.teams via the atomic writer, then a refresh is kicked.
    try {
      await withHubSettingsLock(async () => {          // serialized with every other settings writer
      const body = JSON.parse(await readBody(req));
      const cur = await readHubSettingsForUpdate();
      let teams = Array.isArray(cur.football && cur.football.teams) ? cur.football.teams.slice() : [];
      const action = String(body.action || '').toLowerCase();
      if (action === 'set' && Array.isArray(body.teams)) {
        teams = football.normalizeTeams(body.teams);
      } else if (action === 'remove') {
        const id = football.cleanId(body.id);
        const isLeague = body.type === 'league';
        teams = teams.filter(tm => !(tm.id === id && (tm.type === 'league') === isLeague));
      } else { // add (default)
        const id = football.cleanId(body.id);
        if (!id) { res.writeHead(400); res.end('bad team id'); return; }
        const type = body.type === 'league' ? 'league' : 'team';
        if (!teams.some(tm => tm.id === id && (tm.type === 'league') === (type === 'league'))) {
          teams.push(football.normalizeTeams([{ id, type, name: body.name, badge: body.badge, league: body.league, leagueId: body.leagueId }])[0] || { id });
        }
      }
      const next = { ...cur, football: { ...cur.football, teams } };
      const saved = await writeHubSettings(next);
      hub.settings = saved;
      refreshFootball().catch(() => {});
      json({ ok: true, teams: saved.football.teams });
      });
    } catch (e) { err500(e.message); }
  },

  'POST /api/news/feeds': async (req, res, { json, err500 }, { readHubSettingsForUpdate, writeHubSettings }) => {
    // Add / remove a followed source or topic (or replace the whole list).
    // Persisted in settings.news.feeds via the atomic writer, then a refresh.
    try {
      await withHubSettingsLock(async () => {          // serialized with every other settings writer
      const body = JSON.parse(await readBody(req));
      const cur = await readHubSettingsForUpdate();
      let feeds = Array.isArray(cur.news && cur.news.feeds) ? cur.news.feeds.slice() : [];
      const action = String(body.action || '').toLowerCase();
      if (action === 'set' && Array.isArray(body.feeds)) {
        feeds = news.normalizeFeeds(body.feeds);
      } else if (action === 'remove') {
        const type = body.type === 'topic' ? 'topic' : (body.type === 'custom' ? 'custom' : 'source');
        // topic ids are slugged (idempotent); source/custom ids arrive verbatim from the chip.
        const id = type === 'topic' ? news.topicId(body.id || body.query || body.name) : String(body.id || '');
        feeds = feeds.filter(f => !(f.id === id && f.type === type));
      } else { // add (default)
        const type = body.type === 'topic' ? 'topic' : (body.type === 'custom' ? 'custom' : 'source');
        const entry = type === 'topic'
          ? { type: 'topic', name: body.name || body.query, query: body.query || body.name }
          : type === 'custom'
            ? { type: 'custom', url: body.url, name: body.name }
            : { type: 'source', id: body.id };
        const merged = news.normalizeFeeds([...feeds, entry]);
        if (merged.length === feeds.length) { res.writeHead(400); res.end('bad or duplicate feed'); return; }
        feeds = merged;
      }
      const next = { ...cur, news: { ...cur.news, feeds } };
      const saved = await writeHubSettings(next);
      hub.settings = saved;
      refreshNews().catch(() => {});
      json({ ok: true, feeds: saved.news.feeds });
      });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
