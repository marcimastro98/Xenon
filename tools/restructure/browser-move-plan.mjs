// Says where each loose script of `server/js/` goes, and why a script may not go.
//
// The home of a script is the folder of the feature that owns it in tools/map/features.json: `server/js/<feature id>/`,
// or the folder browser-move-left.json gives the feature (`bit` lives in `server/js/ai/`, as on the engine side).
// The name of a folder is never made up here: it is the id the map already gives the feature, the same name its
// engine code has under `server/`. A script that was split goes in with its parts instead, whatever the feature:
// `deck.js` into `deck/` as `deck/deck.js`. It keeps its own name and never becomes a folder, and goes there only
// when everything that loads it spells the `.js` (browser-move-apply.mjs).

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { assign, globToRegExp } from '../map/map.mjs';
import { MEANING, withoutComments } from './move-plan.mjs';

const posix = path.posix;
export const LEFT = 'tools/restructure/browser-move-left.json';
const LOOSE = /^server\/js\/[^/]+\.js$/;
// A browser script can also ask where it was loaded from.
const BROWSER_MEANING = [...MEANING, ['document.currentScript', /\bcurrentScript\b/]];

/** @param {string} root @returns {{ homes: Record<string, string>, features: Record<string, string>, files: Record<string, string>, lists: string[], outside?: string[], copies?: string[] }} */
export function readLeft(root) {
  return JSON.parse(readFileSync(path.join(root, LEFT), 'utf8'));
}

// Code outside this repo (Xenon Maker, the creator and hub skills) finds a script by its name: `server/js/<name>`
// first, then the one `server/js/*/<name>`. So a name of the list lives once, in the root or one folder down.
const placesOf = (tracked, name) => [...tracked].filter((file) => file.startsWith('server/js/') && posix.basename(file) === name);

/**
 * @param {Iterable<string>} tracked @param {string[]} names file names read from outside (`outside` of the list)
 * @returns {string[]} why an outside reader would not find one of them, or would find two
 */
export function outsideProblems(tracked, names) {
  const problems = [];
  for (const name of names) {
    const places = placesOf(tracked, name);
    const near = places.filter((file) => file.split('/').length <= 4);
    if (!near.length) problems.push(`${name} is read from outside this repo and is neither in server/js/ nor one folder down${places.length ? ` (${places.join(', ')})` : ''}`);
    else if (near.length > 1) problems.push(`${name} is read from outside this repo by its name and has ${near.length} places: ${near.join(', ')}`);
  }
  return problems;
}

/**
 * Where the scripts of some names stand today, in the root of `server/js/` or one folder down.
 * @param {Iterable<string>} tracked @param {string[]} names @returns {Set<string>}
 */
export const standing = (tracked, names) => new Set(names.flatMap((name) => placesOf(tracked, name).filter((file) => file.split('/').length <= 4)));

// The folder that already holds the parts split from a script (`deck/` for `deck.js`), by its plain name; null when there is none.
const partsFolder = (from, tracked) => (tracked.some((file) => file.startsWith(`${from.slice(0, -'.js'.length)}/`)) ? posix.basename(from, '.js') : null);

export const homeGlob = (folder) => `server/js/${folder}/**`;

/**
 * The map with the folder of each feature that gets scripts written into it, so the map owns a script at its new place.
 * A folder the map gives the feature already (the parts of a split script live there) is not written a second time.
 * @param {{id: string, files: string[]}[]} features @param {{to: string, feature: string}[]} moves
 */
export function withHomes(features, moves) {
  const rules = features.flatMap((feature) => feature.files.map((glob) => ({ id: feature.id, test: globToRegExp(glob) })));
  const globs = new Map();
  for (const move of moves) {
    if (rules.find((rule) => rule.test.test(move.to))?.id === move.feature) continue;
    globs.set(move.feature, new Set([...(globs.get(move.feature) ?? []), homeGlob(posix.dirname(move.to).split('/')[2])]));
  }
  return features.map((feature) => {
    const added = [...(globs.get(feature.id) ?? [])].filter((glob) => !feature.files.includes(glob));
    return added.length ? { ...feature, files: [...feature.files, ...added] } : feature;
  });
}

/**
 * @param {{ tracked: string[], features: {id: string, files: string[]}[], left: ReturnType<typeof readLeft>, only?: string }} input
 * @returns {{ moves: {from: string, to: string, feature: string}[], stay: {file: string, why: string}[] }}
 */
export function targets({ tracked, features, left, only }) {
  const { owned } = assign(tracked, features);
  const ownerOf = new Map([...owned].flatMap(([id, files]) => files.map((file) => [file, id])));
  const moves = [];
  const stay = [];
  for (const from of tracked.filter((file) => LOOSE.test(file))) {
    const feature = ownerOf.get(from);
    if (only && feature !== only) continue;
    if (left.files[from]) stay.push({ file: from, why: left.files[from] });
    else if (!feature) stay.push({ file: from, why: 'the map gives it to no feature' });
    else if (left.features[feature]) stay.push({ file: from, why: left.features[feature] });
    else moves.push({ from, to: `server/js/${partsFolder(from, tracked) ?? left.homes[feature] ?? feature}/${posix.basename(from)}`, feature });
  }
  return { moves, stay };
}

/**
 * Why one move may not be made, from what the repo says before anything is read for references.
 * @param {{from: string, to: string, feature?: string}} move
 * @param {{ tracked: Set<string>, frozen: {paths: string[], whole: string[]}, features: object[], dirty: Set<string>,
 *   ignored: (file: string) => boolean, read: (file: string) => string, outside?: Set<string> }} repo `features` already has the new folders (withHomes)
 * @returns {string | null}
 */
export function whyNot(move, repo) {
  const { from, to } = move;
  if (!repo.tracked.has(from)) return 'git does not track it';
  if (!LOOSE.test(from)) return 'not a loose script of server/js/';
  if (repo.frozen.paths.includes(from) || repo.frozen.whole.some((glob) => globToRegExp(glob).test(from))) return 'a frozen path (tools/map/frozen-paths.json)';
  if (repo.dirty.has(from)) return 'it has changes that are not committed';
  if (posix.basename(from) !== posix.basename(to)) return 'a move keeps the name of the file';
  if (!/^server\/js\/[a-z0-9-]+\/[^/]+\.js$/.test(to)) return 'a script goes one folder down, into a folder of server/js/ with a plain name';
  if (repo.tracked.has(to)) return `${to} is already there`;
  const twin = repo.outside?.has(posix.basename(from)) && placesOf(repo.tracked, posix.basename(from)).find((file) => file !== from && file.split('/').length <= 4);
  if (twin) return `it is read from outside this repo by its name, and ${twin} has the same name`;
  const folder = posix.dirname(to);
  const parts = `${from.replace(/\.js$/, '')}/`;
  if (folder !== parts.slice(0, -1) && [...repo.tracked].some((file) => file.startsWith(parts))) return `the parts split from it live in ${parts}: it goes in with them, under its own name, or stays`;
  if (/^server\/js\/(vendor|i18n)$/.test(folder)) return `${folder}/ is not the folder of a feature`;
  if (repo.ignored(to)) return `${folder}/ is ignored by git: the file would be missing from an install`;
  // The first feature with a pattern for the file owns it, as in the map.
  const rules = repo.features.flatMap((feature) => feature.files.map((glob) => ({ id: feature.id, test: globToRegExp(glob) })));
  const owner = (file) => rules.find((rule) => rule.test.test(file))?.id;
  if (owner(from) !== owner(to) || owner(from) === undefined) return 'the map would give it to another feature at the new place';
  const code = withoutComments(repo.read(from));
  const word = BROWSER_MEANING.find(([, test]) => test.test(code));
  return word ? `it says ${word[0]}: its place is part of what it does` : null;
}
