// Turns the reading of Windows notifications on or off: on while a dashboard is open and
// something wants them.

const { sseClients } = require('../http/sse-clients.js');
const winNotif = require('../winnotif.js');
const { winNotifWanted } = require('../settings/notification-switches.js');

function refreshWinNotifWatch() {
  winNotif.sync(winNotifWanted() && sseClients.size > 0);
}

module.exports = { refreshWinNotifWatch };
