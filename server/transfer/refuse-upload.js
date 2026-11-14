'use strict';
// Answers an upload that is refused while its body is still arriving.
//
// Closing a connection that still holds bytes nobody read makes the system send a reset, and
// a reset can throw the answer away before the sender reads it: the phone then shows "network
// error" instead of "too large" and tries the same file again. So the answer goes out first,
// what is still on its way is read and dropped, and the connection is closed only if the
// sender is still sending after a few seconds.

const LINGER_MS = 5000;

/**
 * @param {import('http').IncomingMessage} req the upload, still readable
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {object} body sent as JSON
 * @param {{ lingerMs?: number }} [opts]
 */
function refuseUpload(req, res, status, body, opts) {
  const asked = Number(opts?.lingerMs);
  const lingerMs = asked > 0 ? asked : LINGER_MS;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  if (req.complete) return; // the whole body was read: nothing is on its way

  const socket = req.socket;
  const timer = setTimeout(() => { try { socket.destroy(); } catch { /* already gone */ } }, lingerMs);
  timer.unref();
  const settled = () => clearTimeout(timer);
  req.once('end', settled);       // the sender finished: the connection is clean, leave it
  socket.once('close', settled);  // the sender hung up
  req.resume();                   // read and drop the rest
}

module.exports = { refuseUpload, LINGER_MS };
