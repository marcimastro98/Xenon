'use strict';

// The search of the Xenon menu: every function and setting, whichever section it
// lives in, for someone who knows what they want and not where it is. Any order,
// any case, no accents (js/fuzzy-find.js folds the text the same way everywhere).
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./fuzzy-find.js') : root.FuzzyFind);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuFind = api;
})(typeof window !== 'undefined' ? window : globalThis, function (Fuzzy) {
  // Headings only name a group; the Add row opens a list of its own.
  const SKIPPED = new Set(['heading', 'add', 'tunehead', 'map']);

  // A block of switches is found switch by switch, a widget's adjustments under its name.
  const ownRows = (r) => {
    if (r.kind === 'checks') return (r.groups || []).flatMap((g) => g.items);
    return r.tune ? [r, ...r.tune.flatMap(ownRows).map((t) => ({ ...t, owner: r.label }))] : [r];
  };
  const named = (r) => (r.owner ? { ...r, label: [r.owner, r.label] } : r);

  function matches(words, hay) {
    const folded = Fuzzy.fold(hay);
    return words.every((w) => folded.includes(w));
  }

  // `textOf` turns a row's text into words. Sections without a hit are left out.
  function find(sections, query, textOf) {
    const words = Fuzzy.fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out = [];
    for (const section of sections) {
      const rows = section.rows.flatMap(ownRows).filter((r) => !SKIPPED.has(r.kind) && matches(words, `${textOf(r.label)} ${textOf(r.sub)}`)).map(named);
      if (rows.length) out.push({ ...section, rows });
    }
    return out;
  }

  return { find };
});
