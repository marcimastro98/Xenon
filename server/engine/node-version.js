'use strict';
// Which Node.js versions Xenon runs on safely.
//
// Node 18 and 20 are end of life and get no more security fixes. On the
// supported lines, the October 2026 releases fix CVE-2026-111497 ("Node2Shell",
// an out-of-bounds write in the bundled Brotli decoder, reported exploited):
// Xenon's server fetches answers from webhooks, lights on the LAN and online
// services, and fetch() decompresses Brotli on its own. The installer upgrades
// Node when it is older than this; the server warns at startup if it still is.

const MIN = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };
const LOWEST_SUPPORTED_MAJOR = 22;

function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function atLeast(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return true;
}

/** 'ok' | 'outdated' (supported line, missing the fix) | 'unsupported' (end of life or unknown) */
function nodeSecurityStatus(version = process.version) {
  const v = parse(version);
  if (!v) return 'unsupported';
  if (v[0] < LOWEST_SUPPORTED_MAJOR) return 'unsupported';
  const floor = MIN[v[0]];
  if (floor) return atLeast(v, floor) ? 'ok' : 'outdated';
  // An odd (short-lived) line, or a major newer than this table: odd lines end
  // within months, newer even ones are assumed patched.
  if (v[0] % 2 === 1) return v[0] > 26 ? 'ok' : 'unsupported';
  return v[0] > 26 ? 'ok' : 'outdated';
}

// How to get a patched Node on this OS: the Windows installer upgrades it itself;
// on a Mac or Linux the user's own Node runs Xenon, so the log names their way.
const HOW_TO_UPDATE = {
  win32: 'run the Xenon installer again, or winget upgrade OpenJS.NodeJS.LTS',
  darwin: 'brew upgrade node, or the installer from nodejs.org',
};

/** The startup warning for this Node, or '' when it is patched. */
function nodeWarning(version = process.version, platform = process.platform) {
  const status = nodeSecurityStatus(version);
  if (status === 'ok') return '';
  const how = HOW_TO_UPDATE[platform] || 'your package manager or nodejs.org';
  const what = status === 'outdated' ? 'missing current security fixes' : 'no longer supported';
  return `[node] Node.js ${version} is ${what}: update it to the latest LTS (${how}).`;
}

module.exports = { nodeSecurityStatus, nodeWarning, MIN, LOWEST_SUPPORTED_MAJOR };
