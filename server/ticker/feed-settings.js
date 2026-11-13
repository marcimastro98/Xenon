// What the stocks, football and news feeds read from the settings: the lists the user follows
// and the provider keys.

const stocks = require('../stocks.js');
const football = require('../football.js');
const news = require('../news.js');
const { hub } = require('../settings/current.js');
const { _widgetPlaced } = require('../grid/widget-placed.js');

function _stocksSettings() {
  const s = hub.settings && hub.settings.stocks;
  return (s && typeof s === 'object') ? s : stocks.DEFAULT_STOCKS;
}
function _stocksProviderOpts() {
  return {
    provider: _stocksSettings().provider,
    twelveDataKey: (hub.settings && hub.settings.twelveDataKey) || '',
    finnhubKey: (hub.settings && hub.settings.finnhubKey) || '',
  };
}

// A price alert is for someone who chose what to watch or can see the market. A new
// install watches a default list nobody picked, and the first thing it ever said was
// a toast about an index, on top of the first question. Strict on purpose: an unknown
// layout is what a new install has, so it must not count as the tile being there.
function _stocksAlertsWanted(cfg) {
  const ticker = hub.settings && hub.settings.ticker;
  const onTicker = !!ticker && ticker.enabled === true && !!ticker.sources && ticker.sources.stocks !== false;
  return onTicker || _widgetPlaced('stocks') || !stocks.isDefaultWatchlist(cfg.watchlist);
}

function _footballSettings() {
  const s = hub.settings && hub.settings.football;
  return (s && typeof s === 'object') ? s : football.DEFAULT_FOOTBALL;
}
function _footballOpts() {
  return { sportsDbKey: (hub.settings && hub.settings.sportsDbKey) || '' };
}

function _newsSettings() {
  const s = hub.settings && hub.settings.news;
  return (s && typeof s === 'object') ? s : news.DEFAULT_NEWS;
}
function _newsOpts() {
  return {
    lang: (hub.settings && hub.settings.language) || 'en',
    newsDataKey: (hub.settings && hub.settings.newsDataKey) || '',
  };
}

module.exports = {
  _stocksSettings, _stocksProviderOpts, _stocksAlertsWanted, _footballSettings, _footballOpts,
  _newsSettings, _newsOpts,
};
