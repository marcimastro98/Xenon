// The data the generator embedded, arranged for the views: features in area
// order, each feature's files, the folder tree, and what each folder is for.
const DATA = /*@MAP_DATA@*/null;
const HUES = [250, 200, 155, 120, 80, 45, 15, 340, 300, 275];

const areaIndex = new Map(DATA.areas.map((area, i) => [area.id, i]));
const FEATURES = DATA.areas.flatMap((area) => DATA.features.filter((f) => f.area === area.id));
const featureById = new Map(FEATURES.map((f) => [f.id, f]));
const areaById = new Map(DATA.areas.map((a) => [a.id, a]));
const filesOf = new Map(FEATURES.map((f) => [f.id, []]));
for (const file of DATA.files) if (filesOf.has(file.o)) filesOf.get(file.o).push(file);
for (const list of filesOf.values()) list.sort((a, b) => a.p.localeCompare(b.p));
const fileByPath = new Map(DATA.files.map((f) => [f.p, f]));

/** A name or line in the reader's language. @param {{it: string, en: string}} pair */
const say = (pair) => (pair ? pair[reading.lang] || pair.en : '');
const hueOf = (areaId) => HUES[(areaIndex.get(areaId) ?? 0) % HUES.length];
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
const countOf = (list, key) => list.reduce((n, f) => n + (f[key] ? f[key].length : 0), 0);

/** The folder tree, with how many files each feature owns in each folder. */
function makeTree() {
  const root = { name: '', path: '', dirs: new Map(), files: [], count: 0, owners: new Map() };
  for (const file of DATA.files) {
    let node = root;
    const step = (n) => { n.count += 1; n.owners.set(file.o, (n.owners.get(file.o) || 0) + 1); };
    step(node);
    for (const part of file.p.split('/').slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [], count: 0, owners: new Map() });
      node = node.dirs.get(part);
      step(node);
    }
    node.files.push(file);
  }
  return root;
}
const TREE = makeTree();

/** @param {string} path @returns {object | null} */
function folderAt(path) {
  let node = TREE;
  for (const part of path.split('/')) { node = node.dirs.get(part); if (!node) return null; }
  return node;
}

/**
 * What a folder is for, in one line: the opening comment of the file that names it
 * (weather/weather.js, index.js, routes.js), else of its first described file.
 * @param {string} path
 */
function folderLine(path) {
  const node = folderAt(path);
  if (!node) return '';
  const name = baseName(path);
  const pick = ['', 'index', 'main', 'routes', 'mod', 'lib'].map((stem) => stem || name);
  for (const stem of pick) {
    const hit = node.files.find((f) => f.d && f.p.slice(f.p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '') === stem);
    if (hit) return hit.d;
  }
  const any = node.files.find((f) => f.d);
  return any ? any.d : '';
}

/** Feature names in this folder, most files first. @param {object} node */
function ownersOf(node) {
  return [...node.owners].sort((a, b) => b[1] - a[1]).map(([id]) => featureById.get(id)).filter(Boolean);
}
