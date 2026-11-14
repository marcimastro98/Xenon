// Sends the stocks to every dashboard only when they changed.

const { broadcastSSE } = require('../http/sse-clients.js');
const { stocksState } = require('./stocks-state.js');
const { stocksRefresh } = require('./stocks-refresh-state.js');

// Push only when the data actually changed (refreshedAt excluded): a closed
// market re-fetch then costs the clients zero repaints and zero SSE traffic.
function _pushStocks() {
  const sig = JSON.stringify(stocksState.cache.quotes) + '|' + stocksState.cache.provider;
  if (sig === stocksRefresh.sig) return;
  stocksRefresh.sig = sig;
  broadcastSSE('stocks', stocksState.cache);
}

module.exports = { _pushStocks };
