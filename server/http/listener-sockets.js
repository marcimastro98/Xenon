'use strict';

// Every socket a listener accepted, to end them all when it has to move.
// `closeAllConnections` does not reach a socket upgraded to a WebSocket, and
// `close` waits for each one: with a client connected, the listener stayed shut
// and nothing could reach the server until it was restarted.
function trackSockets(server) {
  const open = new Set();
  server.on('connection', (socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
  });
  return { dropAll: () => { for (const socket of open) socket.destroy(); } };
}

module.exports = { trackSockets };
