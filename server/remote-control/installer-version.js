'use strict';
// The oldest Sunshine that remote control works with, and how two version numbers are compared.

// First Sunshine release with the fixes for CVE-2026-32253 and the September
// 2026 advisories.
const SUNSHINE_MIN_VERSION = '2026.914.233613';

// Numeric, field by field: "2026.914.233613" vs "2025.1001.5". Old semver
// releases (0.23.1) compare lower because their first field is 0.
function parseVersion(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function versionLess(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return true;   // unknown is never treated as new enough
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return false;
}

module.exports = { SUNSHINE_MIN_VERSION, parseVersion, versionLess };
