'use strict';
// Tiny semver helpers for the update check. Only the major.minor.patch triplet
// matters here — release tags are plain (v3.0.1), so anything fancier (ranges,
// prerelease precedence) would be dead weight.

function parseSemver(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// True when a > b. Unparseable input on either side compares as "not newer",
// so a malformed tag can never produce a false update hint.
function semverNewer(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] > pb[i]; }
  return false;
}

module.exports = { parseSemver, semverNewer };
