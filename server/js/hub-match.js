'use strict';
// Hub message targeting (pure logic).
//
// The announcement feed is delivered whole to every install and filtered HERE,
// on the user's machine, against what this dashboard already knows about
// itself. Nothing is sent anywhere to receive a targeted message — that is the
// point of the design, not an implementation detail (see the correlation note in
// server/version-ping.js).
//
// Split out of js/hub-messages.js because this is the code that decides who sees
// what: a bug here shows a message meant for a handful of installs to everyone,
// and that is not recoverable once sent. UMD like sdk-perf.js so it is unit
// tested under Node (test/hub-match.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.HubMatch = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Conditions this client knows how to evaluate. A message carrying any other
  // key matches NOBODY: a filter the client cannot read is a filter it must not
  // assume it satisfies. Without this, a condition added to the feed format
  // later (say `supporter`) would be ignored by every dashboard that shipped
  // before it, and a message meant for supporters would reach everyone.
  const KNOWN_MATCH_KEYS = Object.freeze(['minVersion', 'maxVersion', 'os', 'lang', 'hasEntry']);
  const KNOWN = new Set(KNOWN_MATCH_KEYS);

  // Numeric, part by part, shorter side zero-padded so '4.9' equals '4.9.0'.
  // Deliberately not a semver comparator: the feed pins minVersion/maxVersion to
  // digits-and-dots server-side, so there are no prereleases to order.
  function cmpVersion(a, b) {
    const pa = String(a == null ? '' : a).split('.');
    const pb = String(b == null ? '' : b).split('.');
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = Number(pa[i]);
      const y = Number(pb[i]);
      const nx = Number.isFinite(x) ? x : 0;
      const ny = Number.isFinite(y) ? y : 0;
      if (nx !== ny) return nx < ny ? -1 : 1;
    }
    return 0;
  }

  // ctx: { version, os, lang, installed } where `installed` is a Set (or array)
  // of catalog entry ids this dashboard has receipts for.
  function matches(msg, ctx) {
    const m = msg && msg.match;
    if (!m) return true;                      // no conditions → everyone
    if (typeof m !== 'object' || Array.isArray(m)) return false;

    for (const key of Object.keys(m)) {
      if (!KNOWN.has(key)) return false;      // fail closed, see above
    }

    const c = ctx || {};
    const has = (c.installed instanceof Set)
      ? (id) => c.installed.has(id)
      : (id) => Array.isArray(c.installed) && c.installed.includes(id);

    // An unknown version can't be shown to satisfy a version bound either way.
    if (m.minVersion && (!c.version || cmpVersion(c.version, m.minVersion) < 0)) return false;
    if (m.maxVersion && (!c.version || cmpVersion(c.version, m.maxVersion) > 0)) return false;
    if (m.os && !(Array.isArray(m.os) && m.os.includes(c.os))) return false;
    if (m.lang && !(Array.isArray(m.lang) && m.lang.includes(c.lang))) return false;
    // "has any of these", not all: a note about a family of widgets is for
    // anyone running one of them.
    if (m.hasEntry && !(Array.isArray(m.hasEntry) && m.hasEntry.some(has))) return false;
    return true;
  }

  return { matches, cmpVersion, KNOWN_MATCH_KEYS };
});
