// What the assistant does when asked about stocks, football or the news: prices, scores and
// tables, headlines, and the stocks, teams and feeds the user follows.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const stocks = require('../stocks.js');
const football = require('../football.js');
const news = require('../news.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'get_stock_quote': async ({ fnArgs }, { _stocksProviderOpts }) => {
      let fnResult;
      const syms = String(fnArgs.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
      const quotes = await stocks.fetchQuotes(syms, _stocksProviderOpts());
      fnResult = quotes.length
        ? { quotes: quotes.map(q => ({ symbol: q.symbol, name: q.name, price: q.price, changePct: Number(q.changePct.toFixed(2)), currency: q.currency })) }
        : { error: 'no data for those symbols: check the ticker (Borsa Italiana needs .MI, e.g. ENI.MI)' };
      return fnResult;
  },

  'get_stock_watchlist': async (_context, { refreshStocks }) => {
      let fnResult;
      const fresh = await refreshStocks();
      fnResult = { quotes: (fresh.quotes || []).map(q => ({ symbol: q.symbol, name: q.name, price: q.price, changePct: Number(q.changePct.toFixed(2)), currency: q.currency })) };
      return fnResult;
  },

  'add_stock_favorite': async ({ fnArgs }, { hub, readHubSettingsForUpdate, refreshStocks, withHubSettingsLock, writeHubSettings }) => {
      let fnResult;
      const sym = stocks.cleanSymbol(fnArgs.symbol);
      if (!sym) { fnResult = { error: 'invalid symbol' }; }
      else {
        await withHubSettingsLock(async () => {        // serialized with every other settings writer
          const cur = await readHubSettingsForUpdate();
          const wl = Array.isArray(cur.stocks && cur.stocks.watchlist) ? cur.stocks.watchlist.slice() : [];
          if (!wl.some(w => w.symbol === sym)) wl.push({ symbol: sym });
          const saved = await writeHubSettings({ ...cur, stocks: { ...cur.stocks, watchlist: wl } });
          hub.settings = saved;
        });
        refreshStocks().catch(() => {});
        fnResult = { ok: true, symbol: sym };
      }
      return fnResult;
  },

  'edit_favorites': async ({ fnArgs }, { editFavorites }) => {
      let fnResult;
      fnResult = await editFavorites(fnArgs);
      return fnResult;
  },

  'get_football_scores': async ({ fnArgs }, { refreshFootball }) => {
      let fnResult;
      const fresh = await refreshFootball();
      const wanted = String(fnArgs.team || '').trim().toLowerCase();
      const teams = (fresh.teams || []).filter(td => !wanted || String(td.name || '').toLowerCase().includes(wanted));
      const fmt = (ev) => {
        if (!ev) return null;
        const both = ev.homeScore != null && ev.awayScore != null;
        return {
          match: both ? `${ev.home} ${ev.homeScore}-${ev.awayScore} ${ev.away}` : `${ev.home} vs ${ev.away}`,
          status: ev.status, when: ev.ts || (ev.date + ' ' + ev.time), league: ev.league,
        };
      };
      fnResult = teams.length
        ? { teams: teams.map(td => ({ team: td.name, next: fmt(td.next), last: fmt(td.last) })) }
        : { error: wanted ? 'that team is not in the favorites' : 'no favorite teams yet' };
      return fnResult;
  },

  'get_league_standings': async ({ fnArgs }, { _footballOpts, refreshFootball }) => {
      let fnResult;
      const wanted = String(fnArgs.team || '').trim().toLowerCase();
      const fresh = await refreshFootball();
      // Match a followed favorite (team → its league; league → itself) by name,
      // then fall back to the curated competitions so "Serie A"/"Champions" work
      // even when not followed. An empty query is rejected (would match anything).
      const fav = wanted ? (fresh.teams || []).find(x => String(x.name || '').toLowerCase().includes(wanted)) : null;
      let leagueId = fav ? (fav.type === 'league' ? fav.id : fav.leagueId) : '';
      const season = fav ? fav.season : '';
      if (!leagueId && wanted) { const L = football.searchLeagues(wanted)[0]; if (L) leagueId = L.id; }
      if (!leagueId) { fnResult = { error: 'no league found: name a competition (e.g. "Serie A", "Champions League") or a team you follow' }; }
      else {
        const table = await football.fetchStandings(leagueId, season, _footballOpts());
        fnResult = table
          ? { league: table.league, standings: table.rows.slice(0, 20).map(r => ({ rank: r.rank, team: r.team, played: r.played, points: r.points, gd: r.gd })) }
          : { error: 'standings unavailable for that league right now' };
      }
      return fnResult;
  },

  'get_news_headlines': async ({ fnArgs }, { _newsOpts, refreshNews }) => {
      let fnResult;
      const topic = String(fnArgs.topic || '').trim();
      if (topic) {
        // A specific topic → fetch it fresh (doesn't need to be a followed feed).
        const data = await news.fetchHeadlines([{ type: 'topic', name: topic, query: topic }], _newsOpts());
        fnResult = data.items.length
          ? { headlines: data.items.slice(0, 8).map(it => ({ title: it.title, source: it.source })) }
          : { error: 'no headlines found for that topic' };
      } else {
        const fresh = await refreshNews();
        fnResult = (fresh.items || []).length
          ? { headlines: fresh.items.slice(0, 8).map(it => ({ title: it.title, source: it.source })) }
          : { error: 'no followed news feeds yet' };
      }
      return fnResult;
  },
};

module.exports = { branches };
