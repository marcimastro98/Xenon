// The dashboards listening on the live stream, and the one function that sends an event to all
// of them.

const { SSE_MAX_BUFFERED } = require('./sse-limits.js');

const sseClients = new Set();

function broadcastSSE(event, data) {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    if (res.writableLength > SSE_MAX_BUFFERED) {
      sseClients.delete(res);
      try { res.destroy(); } catch { /* already gone */ }
      continue;
    }
    try { res.write(payload); }
    catch { sseClients.delete(res); }
  }
}

module.exports = { sseClients, broadcastSSE };
