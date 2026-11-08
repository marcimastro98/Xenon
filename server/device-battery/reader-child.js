'use strict';
// The reader's own process. Device reads go through native calls and drivers that can
// crash or never return, which must never take the server with them: index.js starts
// this file for one read and kills it if it does not finish.

const { createGuard } = require('./guard');

function backend() {
  if (process.platform === 'win32') return require('./windows');
  if (process.platform === 'linux') return require('./linux');
  if (process.platform === 'darwin') return require('./darwin');
  return null;
}

async function readOnce({ ask, skip }) {
  const guard = createGuard({ skip, note: (touching) => process.send({ touching }) });
  const reader = backend();
  const devices = reader ? await reader.read({ ask, guard }) : [];
  return { devices, denied: guard.denied };
}

const finish = (message, code) => process.send(message, () => process.exit(code));

process.once('message', (request) => {
  readOnce(request).then((result) => finish({ result }, 0), (e) => finish({ error: e.message }, 1));
});
// The server went away: nobody is left to read for.
process.once('disconnect', () => process.exit(0));
