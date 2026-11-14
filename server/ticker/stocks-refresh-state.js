// What the engine remembers of the stocks tile between refreshes.

const stocksRefresh = {
  refreshing: false,
  lastFetch: 0,
  sig: null,
};

module.exports = { stocksRefresh };
