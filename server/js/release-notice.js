'use strict';
// What a person still has to be told after an update, and nothing else: no DOM,
// no storage, so both surfaces (js/update.js, js/screen-release.js) ask the same
// question and the rules can be tested in Node.
//
// A major stays until it is closed: `whatsNewSeen` holds the id of the last one
// closed. The fixes of a patch or a minor stay until they are seen, then never
// again: `releaseNotesSeen` holds the newest version read. Someone who skipped
// versions gets them merged into one list.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.XenonReleaseNotice = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const parts = (v) => String(v || '').replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);

  function compare(a, b) {
    const x = parts(a);
    const y = parts(b);
    for (let i = 0; i < 3; i += 1) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  // "5.1.0" reads as "5.1", "5.0.2" stays whole.
  function shortVersion(v) {
    const [major, minor, patch] = parts(v);
    return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
  }

  // A string, or a { <lang>: string } map: the language, then English, then anything.
  function localText(v, lang) {
    if (typeof v === 'string') return v;
    if (!v || typeof v !== 'object') return '';
    const keys = Object.keys(v);
    return v[String(lang || 'en').toLowerCase()] || v.en || (keys.length ? v[keys[0]] : '') || '';
  }

  function majorPending(wn, seen) {
    return !!(wn && wn.id && Array.isArray(wn.highlights) && wn.highlights.length && wn.id !== seen);
  }

  function notesPending(wn, seen) {
    const list = wn && Array.isArray(wn.releases) ? wn.releases : [];
    const open = list
      .filter((r) => r && r.version && compare(r.version, wn.version) <= 0 && (!seen || compare(r.version, seen) > 0))
      .sort((a, b) => compare(b.version, a.version));
    if (!open.length) return null;
    return {
      version: open[0].version,
      news: open.flatMap((r) => r.news || []),
      fixes: open.flatMap((r) => r.fixes || []),
    };
  }

  // A failure read once is over. Only a finished attempt with a time counts.
  function failurePending(lastResult, seen) {
    return !!(lastResult && lastResult.ok === false && lastResult.at && String(lastResult.at) !== String(seen || ''));
  }

  function pick({ wn, whatsNewSeen, notesSeen }) {
    return { major: majorPending(wn, whatsNewSeen), notes: notesPending(wn, notesSeen) };
  }

  // The line under the name of a release: how much is in it.
  function summary(notes, tr) {
    const count = (one, many, n) => (n === 1 ? tr(one) : tr(many).replace('{n}', String(n)));
    const lines = [];
    if (notes.news.length) lines.push(count('rn_new_one', 'rn_new_n', notes.news.length));
    if (notes.fixes.length) lines.push(count('rn_fixed_one', 'rn_fixed_n', notes.fixes.length));
    return lines.join(' ');
  }

  // Someone who used Xenon before this boot. What's New does not count: a new install
  // is shown it on its first boot, and closing it there must not end the question.
  function returningUser({ asked, notesSeen, tourSeen }) {
    return !!(asked || notesSeen || tourSeen);
  }

  return { compare, shortVersion, localText, pick, failurePending, returningUser, summary };
});
