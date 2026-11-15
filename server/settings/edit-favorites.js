// Adds or removes a favourite and tells the screens.

const FavoritesAi = require('../favorites-ai.js');
const stocks = require('../ticker/stocks.js');
const football = require('../ticker/football.js');
const { readHubSettingsForUpdate } = require('./read.js');
const { hub } = require('./current.js');
const { writeHubSettings } = require('./write.js');
const { withHubSettingsLock } = require('./write-lock.js');
const { _footballOpts } = require('../ticker/feed-settings.js');
const { refreshStocks } = require('../ticker/stocks-refresh.js');
const { refreshFootball } = require('../ticker/football-refresh.js');
const { refreshNews } = require('../ticker/news-refresh.js');

// edit_favorites: the search runs first (network), the list is changed under the
// settings lock, then the tile's data is refreshed as its own add box does.
const FAVORITE_REFRESH = { stocks: () => refreshStocks(), teams: () => refreshFootball(), news: () => refreshNews() };
async function editFavorites(args) {
  const plan = await FavoritesAi.planFavorite(args, {
    stocks: (q) => stocks.searchSymbols(q),
    teams: (q) => football.searchTeams(q, _footballOpts()),
  });
  if (plan.error) return { ok: false, ...plan };
  let result = null;
  await withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const out = FavoritesAi.applyFavorite(cur, plan);
    result = out.result;
    if (out.patch) hub.settings = await writeHubSettings({ ...cur, ...out.patch });
  });
  if (result && (result.added || result.removed)) FAVORITE_REFRESH[plan.kind]().catch(() => {});
  return result;
}

module.exports = { FAVORITE_REFRESH, editFavorites };
