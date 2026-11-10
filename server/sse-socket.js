'use strict';

// The `/sse` feed over a WebSocket, for the app's own windows (js/live-stream.js
// says why). It looks like the `res` and `req` of an HTTP stream, so a window on a
// socket is one more entry in `sseClients`: the same seeds, broadcasts and pings.

const OPEN = 1;

function socketResponse(client) {
  return {
    write(text) {
      if (client.readyState === OPEN) client.send(text);
      return true;
    },
    end() { client.close(); },
    destroy() { client.terminate(); },
    get writableLength() { return client.bufferedAmount; },
  };
}

function socketRequest(client) {
  return {
    on(event, fn) { if (event === 'close') client.on('close', fn); },
  };
}

module.exports = { socketResponse, socketRequest };
