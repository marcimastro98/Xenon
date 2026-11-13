// What the engine answers for the stocks, football and news tiles: charts, standings, headlines
// and the searches.

const { _stocksChartCache, _stocksSearchCache } = require('./stocks-caches.js');
const stocks = require('../stocks.js');
const {
  _stocksProviderOpts, _footballOpts, _footballSettings, _newsSettings, _stocksSettings,
} = require('./feed-settings.js');
const {
  _footballStandingsCache, _footballNewsCache, FOOTBALL_NEWS_TTL_MS, _footballSearchCache,
} = require('./football-caches.js');
const football = require('../football.js');
const { hub } = require('../settings/current.js');
const news = require('../news.js');
const { refreshNews } = require('./news-refresh.js');
const { newsState } = require('./news-state.js');
const { _newsSearchCache } = require('./news-search-cache.js');
const { stocksState } = require('./stocks-state.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/stocks/chart': async (_req, res, { json, err500, urlObj }) => {
    // Chart candles for the detail view (on-demand, short-cached so range
    // toggles don't re-hit the provider every tap).
    try {
      const symbol = urlObj.searchParams.get('symbol') || '';
      const range = urlObj.searchParams.get('range') || '1d';
      const key = `${symbol}|${range}`;
      const now = Date.now();
      const hit = _stocksChartCache.get(key);
      if (hit && now - hit.at < 30000) { json(hit.data); }
      else {
        const data = await stocks.fetchChart(symbol, range, _stocksProviderOpts());
        if (!data) { res.writeHead(404); res.end('unknown symbol'); return; }
        if (_stocksChartCache.size > 40) _stocksChartCache.delete(_stocksChartCache.keys().next().value);
        _stocksChartCache.set(key, { at: now, data });
        json(data);
      }
    } catch (e) { err500(e.message); }
  },

  'GET /api/stocks/search': async (_req, _res, { json, err500, urlObj }) => {
    // Resolve free text ("apple", "ftse mib") to real tickers so the widget's
    // add box is a search, not a "know the exact symbol" field. Keyless (Yahoo),
    // briefly cached so typing doesn't hammer the endpoint on every keystroke.
    try {
      const q = (urlObj.searchParams.get('q') || '').trim();
      if (!q) { json({ results: [] }); return; }
      const key = q.toLowerCase();
      const now = Date.now();
      const hit = _stocksSearchCache.get(key);
      if (hit && now - hit.at < 60000) { json({ results: hit.results }); return; }
      const results = await stocks.searchSymbols(q);
      if (_stocksSearchCache.size > 40) _stocksSearchCache.delete(_stocksSearchCache.keys().next().value);
      _stocksSearchCache.set(key, { at: now, results });
      json({ results });
    } catch (e) { err500(e.message); }
  },

  'GET /api/football/standings': async (_req, res, { json, err500, urlObj }) => {
    // League table for the detail view (on-demand, short-cached). `season` is
    // supplied by the widget from the team's own fixtures.
    try {
      const leagueId = urlObj.searchParams.get('league') || '';
      const season = urlObj.searchParams.get('season') || '';
      const key = `${leagueId}|${season}`;
      const now = Date.now();
      const hit = _footballStandingsCache.get(key);
      if (hit && now - hit.at < 5 * 60 * 1000) { json(hit.data || {}); return; }
      const data = await football.fetchStandings(leagueId, season, _footballOpts());
      if (!data) { res.writeHead(404); res.end('no standings'); return; }
      if (_footballStandingsCache.size > 40) _footballStandingsCache.delete(_footballStandingsCache.keys().next().value);
      _footballStandingsCache.set(key, { at: now, data });
      json(data);
    } catch (e) { err500(e.message); }
  },

  'GET /api/football/news': async (_req, _res, { json, err500 }) => {
    // Headlines about the followed teams/competitions. TheSportsDB has no news
    // feed, so each favorite becomes a Google News topic and news.js does the
    // fetching, merging and deduping it already does for the News widget.
    // Deliberately OFF the SSE cycle: the network is only touched when the user
    // opens the tab, and the answer is reused for 15 minutes.
    try {
      const cfg = _footballSettings();
      const lang = (hub.settings && hub.settings.language) || 'en';
      const feeds = football.newsQueries(cfg.teams, lang);
      if (!feeds.length) { json({ items: [] }); return; }
      const key = lang + '|' + feeds.map(f => f.query).join('|');
      const now = Date.now();
      if (_footballNewsCache.key === key && now - _footballNewsCache.at < FOOTBALL_NEWS_TTL_MS) {
        json({ items: _footballNewsCache.items, refreshedAt: _footballNewsCache.at });
        return;
      }
      // In-flight dedup: three tiles (Edge, browser, phone) opening the tab at
      // once must not each fire four Google News requests.
      if (!_footballNewsCache.inflight || _footballNewsCache.key !== key) {
        _footballNewsCache.key = key;
        _footballNewsCache.inflight = news.fetchHeadlines(feeds, { lang })
          .then(d => {
            const items = (d && Array.isArray(d.items) ? d.items : []).slice(0, 20);
            _footballNewsCache.at = Date.now();
            _footballNewsCache.items = items;
            return items;
          })
          .catch(() => [])
          .finally(() => { _footballNewsCache.inflight = null; });
      }
      const items = await _footballNewsCache.inflight;
      json({ items, refreshedAt: _footballNewsCache.at });
    } catch (e) { err500(e.message); }
  },

  'GET /api/football/search': async (_req, _res, { json, err500, urlObj }) => {
    // Resolve free text ("napoli") to real teams so the add box is a search.
    try {
      const q = (urlObj.searchParams.get('q') || '').trim();
      if (!q) { json({ results: [] }); return; }
      const key = q.toLowerCase();
      const now = Date.now();
      const hit = _footballSearchCache.get(key);
      if (hit && now - hit.at < 60000) { json({ results: hit.results }); return; }
      // Competitions (curated, instant) first, then clubs (live search).
      const leagues = football.searchLeagues(q);
      const teams = await football.searchTeams(q, _footballOpts());
      const results = [...leagues, ...teams].slice(0, 12);
      if (_footballSearchCache.size > 40) _footballSearchCache.delete(_footballSearchCache.keys().next().value);
      _footballSearchCache.set(key, { at: now, results });
      json({ results });
    } catch (e) { err500(e.message); }
  },

  'GET /api/news': async (_req, _res, { json, err500, urlObj }) => {
    // Current merged headlines (+ the config the widget needs to render).
    try {
      if (urlObj.searchParams.has('refresh')) await refreshNews();
      // A GET is proof someone wants the data (widget just added, ticker source
      // just enabled) — the gated timers may not have run yet, so if the cache
      // is cold, refresh in background; the SSE push repaints when it lands.
      else if (!newsState.cache.refreshedAt || Date.now() - newsState.cache.refreshedAt > 15 * 60 * 1000) refreshNews().catch(() => {});
      const cfg = _newsSettings();
      json({ items: newsState.cache.items, refreshedAt: newsState.cache.refreshedAt, feeds: cfg.feeds, tile: cfg.tile });
    } catch (e) { err500(e.message); }
  },

  'GET /api/news/search': async (_req, _res, { json, err500, urlObj }) => {
    // Resolve free text to curated sources (the caller can also add it as a topic).
    try {
      const q = (urlObj.searchParams.get('q') || '').trim();
      if (!q) { json({ results: [] }); return; }
      const key = q.toLowerCase();
      const now = Date.now();
      const hit = _newsSearchCache.get(key);
      if (hit && now - hit.at < 60000) { json({ results: hit.results }); return; }
      const results = news.searchSources(q);
      if (_newsSearchCache.size > 40) _newsSearchCache.delete(_newsSearchCache.keys().next().value);
      _newsSearchCache.set(key, { at: now, results });
      json({ results });
    } catch (e) { err500(e.message); }
  },

  'GET /api/stocks': async (_req, _res, { json, err500, urlObj }, { refreshStocks }) => {
    // Current quotes for the watchlist (+ the config the widget needs to render).
    try {
      if (urlObj.searchParams.has('refresh')) await refreshStocks();
      const cfg = _stocksSettings();
      json({ quotes: stocksState.cache.quotes, provider: stocksState.cache.provider, refreshedAt: stocksState.cache.refreshedAt, watchlist: cfg.watchlist, tile: cfg.tile, alertPercent: cfg.alertPercent });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
