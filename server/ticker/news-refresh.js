// Fetches the headlines of the followed feeds, keeps the last good ones when a fetch fails, and
// sends them to the screens only when they changed.

const { broadcastSSE } = require('../http/sse-clients.js');
const news = require('../news.js');
const { _newsSettings, _newsOpts } = require('./feed-settings.js');
const { newsState } = require('./news-state.js');

function _pushNews() {
  const sig = JSON.stringify(newsState.cache.items);
  if (sig === newsState.sentSig) return;
  newsState.sentSig = sig;
  broadcastSSE('news', newsState.cache);
}

async function refreshNews() {
  if (newsState.refreshing) return newsState.cache;
  newsState.lastFetch = Date.now();
  const cfg = _newsSettings();
  if (!Array.isArray(cfg.feeds) || !cfg.feeds.length) {
    newsState.cache = { items: [], refreshedAt: Date.now() };
    _pushNews();
    return newsState.cache;
  }
  newsState.refreshing = true;
  try {
    const data = await news.fetchHeadlines(cfg.feeds, _newsOpts());
    if (data.items.length) newsState.cache = { items: data.items, refreshedAt: Date.now() };
    _pushNews();
  } catch { /* keep last good cache */ }
  finally { newsState.refreshing = false; }
  return newsState.cache;
}

module.exports = { _pushNews, refreshNews };
