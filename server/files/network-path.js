// Tells whether a path points at another computer on the network, which Windows would sign in
// to just by touching it.

// \\host\share, //host/share, \\?\UNC\host: touching one makes Windows
// authenticate to that host with the user's credentials.
function isNetworkPath(p) {
  const s = String(p || '').trim();
  if (/^[\\/]{2}[?.][\\/]/.test(s)) return /^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(s);
  return /^[\\/]{2}/.test(s);
}

module.exports = { isNetworkPath };
