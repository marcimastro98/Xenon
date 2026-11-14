// Loaded before a throwaway engine (`node --require`): no TCP connection leaves this
// computer. A check that seeds invented keys, a watchlist or a Home Assistant address
// would otherwise send them to real services every time the engine refreshes a feed.
// A connection to this computer itself goes through, so the check can still ask the
// engine and stand a local server in for a provider.
//
// Only TCP: what the engine sends over UDP or through a program it starts is not held.

const net = require('node:net');

const LOCAL = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Where a call of `socket.connect(...)` is going: a host, or null for a pipe.
 * @param {any[]} args the arguments as given, or already gathered into one array by Node
 * @returns {string | null}
 */
function targetOf(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') return first.path ? null : String(first.host ?? '');
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  return typeof args[1] === 'string' ? args[1] : '';
}

/** @param {string | null} host @returns {boolean} whether a connection there stays on this computer */
function staysHere(host) {
  return host === null || LOCAL.has(String(host).trim().toLowerCase());
}

function install() {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connectHere(...args) {
    const host = targetOf(args);
    if (staysHere(host)) return connect.apply(this, args);
    const refused = Object.assign(new Error(`connect ECONNREFUSED ${host} (this engine is kept off the network)`), { code: 'ECONNREFUSED' });
    process.nextTick(() => this.destroy(refused));
    return this;
  };
}

// Only the rig asks for it, so a test can load this file and nothing changes.
if (process.env.XENON_RIG_NO_NETWORK === '1') install();

module.exports = { targetOf, staysHere };
