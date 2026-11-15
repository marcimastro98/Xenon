// Says where each loose file of `server/` goes, and why a file may not go.
//
// The home of a file is the folder of the feature that owns it in tools/map/features.json: `server/<feature id>/`
// when that folder exists, or the folder move-left.json gives the feature (`homes`) or the one file (`places`).
// No folder is ever made up: a feature without one keeps its files where they are, and the report says so, unless
// move-left.json lists the folder as one a move may make (`makes`: a folder named like its feature).
//
// `__dirname` and `require.resolve` stop a move here; a caller that follows them itself (move-place.mjs) says so.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { assign, globToRegExp } from '../map/map.mjs';

const posix = path.posix;
const ROOT_FILE = /^server\/[^/]+\.js$/;
// The static route hands out these folders of `server/` to any page (the test of the route in server.js).
export const SERVED = ['styles', 'components', 'js', 'vendor', 'public', 'shared', 'assets', 'sdk-example', 'data', 'test'];
// Words whose meaning is the place of the file itself, or that make the file a program started by path.
export const MEANING = [
  ['__dirname', /\b__dirname\b/], ['__filename', /\b__filename\b/], ['require.resolve', /\brequire\.resolve\b/],
  ['process.argv', /\bprocess\.argv\b/], ['require.main', /\brequire\.main\b/], ['import.meta', /\bimport\.meta\b/],
  ['module.filename or module.paths', /\bmodule\.(filename|path|paths|id|parent)\b/], ['require.cache', /\brequire\.cache\b/],
  ['a require of a name worked out at run time', /\brequire\(\s*(?:[^'"`)\s]|(['"`])[^'"`\n]*\1\s*[^)\s])/],
];

export const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');

/** @param {string} root @returns {{ homes: Record<string, string>, places?: Record<string, string>, makes?: string[], features: Record<string, string>, files: Record<string, string> }} */
export function readLeft(root) {
  return JSON.parse(readFileSync(path.join(root, 'tools', 'restructure', 'move-left.json'), 'utf8'));
}

/**
 * @param {{ tracked: string[], features: {id: string, files: string[]}[], left: ReturnType<typeof readLeft>, only?: string }} input
 * @returns {{ moves: {from: string, to: string, feature: string}[], stay: {file: string, why: string}[] }}
 */
export function targets({ tracked, features, left, only }) {
  const { owned } = assign(tracked, features);
  const ownerOf = new Map([...owned].flatMap(([id, files]) => files.map((file) => [file, id])));
  const folders = new Set([...tracked.filter((file) => /^server\/[^/]+\//.test(file)).map((file) => file.split('/')[1]), ...(left.makes ?? []).map((folder) => folder.split('/')[1])]);
  const moves = [];
  const stay = [];
  for (const from of tracked.filter((file) => ROOT_FILE.test(file))) {
    const feature = ownerOf.get(from);
    if (only && feature !== only) continue;
    const folder = left.places?.[from] ?? left.homes[feature] ?? feature;
    const names = features.find((entry) => entry.id === feature)?.files.includes(`server/${folder}/**`);
    if (left.files[from]) stay.push({ file: from, why: left.files[from] });
    else if (left.features[feature]) stay.push({ file: from, why: left.features[feature] });
    else if (!feature || !folders.has(folder) || !names) stay.push({ file: from, why: `the map gives the feature "${feature}" no folder of its own` });
    else moves.push({ from, to: `server/${folder}/${posix.basename(from)}`, feature });
  }
  return { moves, stay };
}

/**
 * Why one move may not be made, from what the repo says before anything is read for references.
 * @param {{from: string, to: string}} move
 * @param {{ tracked: Set<string>, frozen: {paths: string[], whole: string[]}, features: object[], dirty: Set<string>,
 *   ignored: (file: string) => boolean, read: (file: string) => string, makes?: string[], follows?: Set<string> }} repo
 *   `makes`: folders a move may make; `follows`: words of MEANING the caller checks itself
 * @returns {string | null}
 */
export function whyNot(move, repo) {
  const { from, to } = move;
  if (!repo.tracked.has(from)) return 'git does not track it';
  if (repo.frozen.paths.includes(from) || repo.frozen.whole.some((glob) => globToRegExp(glob).test(from))) return 'a frozen path (tools/map/frozen-paths.json)';
  if (repo.dirty.has(from)) return 'it has changes that are not committed';
  if (posix.basename(from) !== posix.basename(to)) return 'a move keeps the name of the file';
  if (repo.tracked.has(to)) return `${to} is already there`;
  const folder = posix.dirname(to);
  if (folder === from.replace(/\.js$/, '') || folder.startsWith(`${from.replace(/\.js$/, '')}/`)) return 'x.js may never become the folder x/: an install that kept the old file would load it first';
  if (![...repo.tracked].some((file) => file.startsWith(`${folder}/`)) && !repo.makes?.includes(folder)) return `${folder}/ does not exist: a move makes no folder`;
  const [top, under] = folder.split('/');
  if (top === 'server' && SERVED.includes(under)) return `${folder}/ is handed out to pages or is not code that ships`;
  if (repo.ignored(to)) return `${folder}/ is ignored by git: the file would be missing from an install`;
  // The first feature with a pattern for the file owns it, as in the map.
  const owner = (file) => repo.features.find((feature) => feature.files.some((glob) => globToRegExp(glob).test(file)))?.id;
  if (owner(from) !== owner(to)) return 'the map would give it to another feature at the new place';
  const code = withoutComments(repo.read(from));
  const word = MEANING.find(([name, test]) => !repo.follows?.has(name) && test.test(code));
  return word ? `it says ${word[0]}: its place is part of what it does` : null;
}

/**
 * The relative loads of a moving file, spelled for its new folder. A file it loads may be moving too.
 * @param {{from: string, to: string}} move @param {{start: number, end: number, was: string}[]} loads from loadsOf
 * @param {{from: string, to: string}[]} moves every move of the step
 * @returns {{start: number, end: number, was: string, text: string}[]} only the ones whose spelling changes
 */
export function ownLoads(move, loads, moves) {
  const strip = (file) => file.replace(/\.js$/, '');
  return loads.map((load) => {
    const lexical = posix.join(posix.dirname(move.from), load.was);
    const other = moves.find((candidate) => candidate.from === lexical || strip(candidate.from) === lexical);
    const target = !other ? lexical : load.was.endsWith('.js') ? other.to : strip(other.to);
    let text = posix.relative(posix.dirname(move.to), target);
    if (!text.startsWith('.')) text = `./${text}`;
    if (load.was.endsWith('/') && !text.endsWith('/')) text += '/';
    return { ...load, text };
  }).filter((load) => load.text !== load.was);
}
