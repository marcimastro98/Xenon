// Says what is still in a big file, grouped by the feature it belongs to, and what
// keeps each part there. A declaration's feature is read from the modules it
// requires, then from words in its name, then from the declarations around it: a guide for
// choosing the next extraction, not a proof.

// Owners that say nothing about which feature the code serves.
const GENERIC = new Set(['engine-core', 'helpers-shared', 'shared-core', 'platform', 'tools', 'tests', 'project', 'quality-tools']);
const STATE_CODES = new Set(['is-shared-state', 'reassigns', 'changes-in-place', 'reads-state']);

const words = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());

/**
 * Words that name a feature: the one-word feature ids, and the words of feature-words.json.
 * @param {{id: string}[]} features from tools/map/features.json
 * @param {Record<string, string>} [extra] word to feature id
 * @returns {Map<string, string>} word to feature id
 */
export function featureWords(features, extra = {}) {
  const ids = features.map((feature) => feature.id).filter((id) => !GENERIC.has(id) && !id.includes('-'));
  return new Map([...ids.map((id) => [id, id]), ...Object.entries(extra)]);
}

function leader(votes) {
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  return ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
}

function whyStuck(record, kept) {
  if (record.names.some((name) => kept.has(name))) return 'kept';
  if (record.movable) return 'movable';
  const codes = record.blockers.map((blocker) => blocker.code);
  if (record.loadTime || !['function', 'class', 'const'].includes(record.kind) || codes.includes('needs-a-module-loaded-later')) return 'order';
  if (codes.some((code) => STATE_CODES.has(code))) return 'state';
  if (codes.includes('bound-to-this-file')) return 'file';
  return 'needs';
}

/**
 * The feature each statement of the file most likely serves.
 * @param {{ records: any[], bindings: Map<string, any> }} analysis from analyze.mjs
 * @param {object} map
 * @param {(spec: string) => string | null} map.ownerOfSpec feature id of a required module
 * @param {Map<string, string>} map.words from featureWords
 * @param {Set<string>} [map.kept] names that never move (protected.json)
 * @returns {Map<any, string>} record to feature id, for every statement that is not a require
 */
export function featuresOf(analysis, { ownerOfSpec, words: known, kept = new Set() }) {
  const { records, bindings } = analysis;
  const left = records.filter((record) => record.kind !== 'require');
  const feature = new Map();
  for (const record of left) {
    if (record.names.some((name) => kept.has(name))) { feature.set(record, 'engine-core'); continue; }
    const votes = new Map();
    for (const name of record.requires) {
      const owner = ownerOfSpec(bindings.get(name).record.require.spec);
      if (owner && !GENERIC.has(owner)) votes.set(owner, (votes.get(owner) ?? 0) + 1);
    }
    const byName = new Map();
    for (const word of record.names.flatMap(words)) if (known.has(word)) byName.set(known.get(word), (byName.get(known.get(word)) ?? 0) + 1);
    const found = leader(votes) ?? leader(byName);
    if (found) feature.set(record, found);
  }
  // A declaration between two worlds takes the one all its neighbours in the call graph share.
  const users = new Map(left.map((record) => [record, []]));
  for (const record of left) for (const name of record.deps) users.get(bindings.get(name).record)?.push(record);
  for (let grew = true; grew;) {
    grew = false;
    for (const record of left) {
      if (feature.has(record)) continue;
      const near = [...record.deps.map((name) => bindings.get(name).record), ...users.get(record)].map((r) => feature.get(r)).filter(Boolean);
      if (near.length && near.every((id) => id === near[0])) { feature.set(record, near[0]); grew = true; }
    }
  }
  // What is left sits next to its feature in the file.
  let last = 'engine-core';
  for (const record of left) {
    if (feature.has(record)) last = feature.get(record); else feature.set(record, last);
  }
  return feature;
}

/**
 * @param {{ records: any[], bindings: Map<string, any> }} analysis from analyze.mjs
 * @param {Parameters<typeof featuresOf>[1]} map
 * @returns {{ feature: string, declarations: number, lines: number, movable: number, state: number, order: number,
 *   file: number, needs: number, kept: number, sharedState: string[] }[]} biggest first; the numbers after `declarations` are lines
 */
export function remainder(analysis, map) {
  const feature = featuresOf(analysis, map);
  const rows = new Map();
  for (const record of feature.keys()) {
    const id = feature.get(record);
    if (!rows.has(id)) rows.set(id, { feature: id, declarations: 0, lines: 0, movable: 0, state: 0, order: 0, file: 0, needs: 0, kept: 0, touched: new Map() });
    const row = rows.get(id);
    const lines = record.range[1] - record.range[0] + 1;
    row.declarations += 1;
    row.lines += lines;
    row[whyStuck(record, map.kept ?? new Set())] += lines;
    for (const name of new Set([...record.state, ...record.writes, ...record.changes])) row.touched.set(name, (row.touched.get(name) ?? 0) + 1);
  }
  return [...rows.values()].sort((a, b) => b.lines - a.lines).map(({ touched, ...row }) => ({
    ...row, sharedState: [...touched].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name]) => name),
  }));
}

/** @param {ReturnType<typeof remainder>} rows @returns {string} a text table */
export function renderRemainder(rows) {
  const head = ['feature', 'decl', 'lines', 'movable', 'state', 'order', 'file', 'needs', 'kept', 'most-touched shared state'];
  const body = rows.map((r) => [r.feature, r.declarations, r.lines, r.movable, r.state, r.order, r.file, r.needs, r.kept, r.sharedState.join(', ')].map(String));
  const total = (key) => String(rows.reduce((sum, row) => sum + row[key], 0));
  body.push(['total', total('declarations'), total('lines'), total('movable'), total('state'), total('order'), total('file'), total('needs'), total('kept'), '']);
  const width = head.map((title, i) => Math.max(title.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => (i === 0 || i === cells.length - 1 ? cell.padEnd(width[i]) : cell.padStart(width[i]))).join('  ').trimEnd();
  return [line(head), ...body.map(line),
    '', 'Lines per reason: movable = can go now; state = reads or writes shared variables of the file;',
    'order = runs when the file loads, is a let, or needs a module the file loads too late; file = uses require/__dirname inside;',
    'needs = waits for one of the others; kept = the start-up and security code that never moves (protected.json).'].join('\n');
}

/**
 * The declarations that can move now, under the feature they most likely serve.
 * @param {{ records: any[], bindings: Map<string, any> }} analysis
 * @param {Parameters<typeof featuresOf>[1]} map
 * @returns {string} per feature: first line, number of lines and names of each declaration
 */
export function renderMovable(analysis, map) {
  const groups = new Map();
  for (const [record, id] of featuresOf(analysis, map)) {
    if (!record.movable || record.names.length === 0 || record.names.some((name) => map.kept?.has(name))) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(record);
  }
  const lines = (record) => record.range[1] - record.range[0] + 1;
  const row = (r) => `  ${String(r.line[0]).padStart(6)}  ${String(lines(r)).padStart(4)}  ${r.names.join(', ')}`;
  return [...groups].map(([id, list]) => [`${id}: ${list.length} declarations, ${list.reduce((sum, r) => sum + lines(r), 0)} lines`,
    ...list.map(row)].join('\n')).join('\n\n');
}
