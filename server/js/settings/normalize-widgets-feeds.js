// Cleans the saved SDK-widget settings and the stocks, football, news and ticker feeds.
'use strict';

// Third-party widget SDK (client-owned schema; the server round-trips it via
// sanitizeServerPassthrough). Strict opt-in known-key rebuild: the feature flag,
// tile→package assignments and per-package grants all collapse to safe empties
// on anything malformed — a corrupted blob can never grant a widget more than
// the user explicitly allowed.
// MUST mirror sdk-widgets.js SDK_STREAMS and Object.keys(SDK_ACTION_CATEGORIES)
// — a grant carrying a stream/action the server allows but this list omits gets
// silently stripped on save, so the widget is granted a capability it can never
// use (the exact bug where a to-do widget's `tasks` stream+action were dropped,
// leaving it empty and un-writable). server/test/sdk-grant-cats-sync guards this.
// Addresses the user typed into a manifest's userHosts slots, keyed by slot id.
// Same reasoning as SDK_HOST_RE: keep the shape, let sdk-widgets.js
// resolveUserHosts be the authority — it re-validates host and scope on every
// proxied request, so nothing here can widen the allowlist. What this DOES have
// to get right is round-tripping the value unharmed: a key silently dropped on
// save is a host the user configured that never reaches the server.
function normalizeSdkUserHosts(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 4) break;
    if (!SDK_SUB_ID_RE.test(key)) continue;
    const slot = v[key];
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue;
    const host = String(slot.host || '').trim().toLowerCase();
    if (!SDK_HOST_RE.test(host)) continue;
    const port = Number(slot.port);
    out[key] = {
      host,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0,
      scheme: slot.scheme === 'https' ? 'https' : 'http',
    };
    n++;
  }
  return out;
}
function normalizeSdkWidgets(value) {
  const v = value && typeof value === 'object' ? value : {};
  const assign = {};
  let n = 0;
  if (v.assign && typeof v.assign === 'object') {
    for (const key of Object.keys(v.assign)) {
      if (n >= 32) break;
      if (!/^(custom|weather)(~[a-z0-9]+)?$/.test(key)) continue;   // weather: a Weather tile on Style 'Your widget'
      const pkg = String(v.assign[key] || '');
      if (!SDK_PACKAGE_ID_RE.test(pkg)) continue;
      assign[key] = pkg; n++;
    }
  }
  const grants = {};
  n = 0;
  if (v.grants && typeof v.grants === 'object') {
    for (const key of Object.keys(v.grants)) {
      if (n >= 32) break;
      if (!SDK_PACKAGE_ID_RE.test(key)) continue;
      const g = v.grants[key];
      if (!g || typeof g !== 'object') continue;
      grants[key] = {
        streams: Array.isArray(g.streams) ? g.streams.filter((s, i, a) => SDK_WIDGET_STREAMS.includes(s) && a.indexOf(s) === i) : [],
        actions: Array.isArray(g.actions) ? g.actions.filter((s, i, a) => SDK_WIDGET_ACTION_CATS.includes(s) && a.indexOf(s) === i) : [],
        hosts: Array.isArray(g.hosts) ? g.hosts.filter((s, i, a) => typeof s === 'string' && SDK_HOST_RE.test(s) && a.indexOf(s) === i).slice(0, 8) : [],
        hooks: Array.isArray(g.hooks) ? g.hooks.filter((s, i, a) => typeof s === 'string' && SDK_SUB_ID_RE.test(s) && a.indexOf(s) === i).slice(0, 8) : [],
        handlers: Array.isArray(g.handlers) ? g.handlers.filter((s, i, a) => typeof s === 'string' && SDK_SUB_ID_RE.test(s) && a.indexOf(s) === i).slice(0, 8) : [],
        // The all-or-nothing consent flags and the user-filled addresses. These
        // MUST be listed: this rebuild is an allowlist, so a key it omits is
        // stripped from the grant on every save. Omitting `storage`/`secrets`
        // silently disabled both features and — because grantNeedsReview asks
        // "does the manifest declare something the grant lacks?" — pinned any
        // widget requesting them in a permanent "asks for new permissions" loop.
        storage: g.storage === true,
        secrets: g.secrets === true,
        island: g.island === true,
        islandDynamic: g.islandDynamic === true,
        islandFull: g.islandFull === true,
        badge: g.badge === true,
        badgeAction: g.badgeAction === true,
        mini: g.mini === true,
        topbarButton: g.topbarButton === true,
        clipboard: g.clipboard === true,
        ai: g.ai === true,
        accent: g.accent === true,
        expand: g.expand === true,
        userHosts: normalizeSdkUserHosts(g.userHosts),
      };
      // The shared store the user approved (manifest `storageGroup`; '' for the
      // package's own). Left OUT, not blanked, when the stored grant has none:
      // the server tells a grant that predates the field from one approved with
      // no group, and fills the first from the installed package once.
      if (typeof g.storageGroup === 'string' && (g.storageGroup === '' || SDK_SUB_ID_RE.test(g.storageGroup))) {
        grants[key].storageGroup = g.storageGroup;
      }
      n++;
    }
  }
  // Per-package pause list (Store → Installed → Sospendi). Grants/assignments
  // stay intact — resuming brings the widget back exactly as it was.
  const suspended = (window.SdkPerf && typeof SdkPerf.normalizeSuspended === 'function')
    ? SdkPerf.normalizeSuspended(v.suspended, SDK_PACKAGE_ID_RE)
    : (Array.isArray(v.suspended) ? v.suspended.filter((s, i, a) => typeof s === 'string' && SDK_PACKAGE_ID_RE.test(s) && a.indexOf(s) === i).slice(0, 32) : []);
  return { enabled: v.enabled === true, assign, grants, suspended };
}

// Stock (Borsa) config — mirrors server/stocks.js normalizeStocks. Watchlist
// symbols are cleaned to the ticker charset; provider keys are handled separately
// (server-only, redacted). Known-key rebuild, bounded.
function normalizeStocksClient(value) {
  const src = value && typeof value === 'object' ? value : {};
  const provider = STOCK_PROVIDER_IDS.includes(src.provider) ? src.provider : 'auto';
  const refreshSec = clampNumber(src.refreshSec, 30, 900, 60);
  const alertPercent = clampNumber(src.alertPercent, 0.5, 25, 2);
  const tile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  let watchlist;
  if (Array.isArray(src.watchlist)) {
    watchlist = [];
    const seen = new Set();
    for (const e of src.watchlist) {
      const sym = String((e && e.symbol != null) ? e.symbol : (e || '')).trim().toUpperCase().slice(0, 20);
      if (!/^[A-Z0-9.\-^=]+$/.test(sym) || seen.has(sym)) continue;
      seen.add(sym);
      const name = String((e && e.name) || '').trim().slice(0, 60);
      watchlist.push(name ? { symbol: sym, name } : { symbol: sym });
      if (watchlist.length >= 30) break;
    }
  } else {
    watchlist = DEFAULT_HUB_SETTINGS.stocks.watchlist.map(w => ({ ...w }));
  }
  return { watchlist, provider, refreshSec, alertPercent, tile: { chart: tile.chart !== false, sparklines: tile.sparklines !== false } };
}

// Football (Calcio) config — mirrors server/football.js normalizeFootball. Team
// ids are numeric strings; the Premium key is handled separately (server-only,
// redacted). Known-key rebuild, bounded.
function normalizeFootballClient(value) {
  const src = value && typeof value === 'object' ? value : {};
  const refreshSec = clampNumber(src.refreshSec, 60, 900, 120);
  const tile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  let teams;
  if (Array.isArray(src.teams)) {
    teams = [];
    const seen = new Set();
    for (const e of src.teams) {
      const id = String((e && e.id != null) ? e.id : (e || '')).trim();
      if (!/^[0-9]{1,12}$/.test(id)) continue;
      const isLeague = !!(e && typeof e === 'object' && e.type === 'league');
      const key = (isLeague ? 'L:' : 'T:') + id;
      if (seen.has(key)) continue;
      seen.add(key);
      const team = { id };
      if (isLeague) team.type = 'league';
      if (e && typeof e === 'object') {
        const name = String(e.name || '').trim().slice(0, 60);
        const badge = String(e.badge || '').trim().slice(0, 300);
        const league = String(e.league || '').trim().slice(0, 60);
        const leagueId = String(e.leagueId || '').trim();
        if (name) team.name = name;
        if (/^https:\/\//i.test(badge)) team.badge = badge;
        if (league) team.league = league;
        if (/^[0-9]{1,12}$/.test(leagueId)) team.leagueId = leagueId;
      }
      teams.push(team);
      if (teams.length >= 20) break;
    }
  } else {
    teams = DEFAULT_HUB_SETTINGS.football.teams.map(tm => ({ ...tm }));
  }
  return { teams, refreshSec, alerts: src.alerts !== false, tile: { results: tile.results !== false, standings: tile.standings !== false } };
}

// News config — mirrors server/news.js normalizeNews. Feeds are followed sources
// (curated ids) or free-text topics; the NewsData.io key is handled separately
// (server-only, redacted). Known-key rebuild, bounded.
//
// `langCode` is read ONLY to build a first feed set. A saved list is the user's
// and is never rewritten, whatever language they later switch to.
function normalizeNewsClient(value, langCode) {
  const src = value && typeof value === 'object' ? value : {};
  const refreshSec = clampNumber(src.refreshSec, 120, 3600, 600);
  const tile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  let feeds;
  if (Array.isArray(src.feeds)) {
    feeds = [];
    const seen = new Set();
    for (const e of src.feeds) {
      if (!e || typeof e !== 'object') continue;
      if (e.type === 'topic') {
        const query = String(e.query || e.name || '').trim().slice(0, 60);
        const id = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        if (!id || seen.has('t:' + id)) continue;
        seen.add('t:' + id);
        feeds.push({ id, type: 'topic', name: String(e.name || query).trim().slice(0, 40), query });
      } else if (e.type === 'custom') {
        // User-added RSS URL. The server assigns the deterministic id + validates the
        // host; the client only preserves what came back, so a plain settings save
        // (e.g. toggling "show images") can't drop or corrupt a custom feed.
        const id = String(e.id || '').trim().slice(0, 40);
        const url = String(e.url || '').trim().slice(0, 600);
        if (!id || !/^https:\/\//i.test(url) || seen.has('c:' + id)) continue;
        seen.add('c:' + id);
        feeds.push({ id, type: 'custom', name: String(e.name || '').trim().slice(0, 40), url });
      } else {
        const id = String(e.id || '').trim().slice(0, 40);
        if (!id || seen.has('s:' + id)) continue;
        seen.add('s:' + id);
        feeds.push({ id, type: 'source', name: String(e.name || id).trim().slice(0, 40) });
      }
      if (feeds.length >= 12) break;
    }
  } else {
    // `lang` (i18n.js) is the language actually on screen; the stored setting is
    // '' until the user picks one explicitly, and seeding from '' would hand
    // every browser-locale install the English default.
    feeds = defaultNewsFeedsClient(langCode || (typeof lang === 'string' ? lang : ''));
  }
  return { feeds, refreshSec, tile: { images: tile.images !== false } };
}

function normalizeTickerClient(value) {
  const v = value && typeof value === 'object' ? value : {};
  const s = v.sources && typeof v.sources === 'object' ? v.sources : {};
  return {
    enabled: v.enabled === true,
    position: v.position === 'top' ? 'top' : 'bottom',
    speed: clampNumber(v.speed, 10, 100, 50),
    sources: { stocks: s.stocks !== false, football: s.football !== false, news: s.news !== false },
  };
}
