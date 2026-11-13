// Says why a path cannot be the home of a new module: the rules of
// structure-conventions (frozen paths, `x.js` never becomes `x/`, folders the app
// serves or git ignores, every file has an owner, shared code never requires a feature).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { assign, globToRegExp, readMap } from '../map/map.mjs';

// The static route serves these folders: code placed there becomes downloadable.
const SERVED = new Set(['styles', 'components', 'js', 'vendor', 'public', 'shared', 'assets', 'test']);
const SHARED_FEATURES = new Set(['helpers-shared', 'shared-core']);
const KEBAB = '[a-z0-9]+(?:-[a-z0-9]+)*';

/** @param {string} root @returns {(file: string) => boolean} true for a path that never moves */
export function frozenTest(root) {
  const frozen = JSON.parse(readFileSync(path.join(root, 'tools', 'map', 'frozen-paths.json'), 'utf8'));
  const exact = new Set(frozen.paths ?? []);
  const globs = (frozen.whole ?? []).map(globToRegExp);
  return (file) => exact.has(file) || globs.some((glob) => glob.test(file));
}

/**
 * Gives each file its feature id from tools/map/features.json, or null.
 * @param {string[]} files repo-relative
 * @returns {Map<string, string | null>}
 */
export function ownersOf(files) {
  const { owned } = assign(files, readMap().features);
  const owners = new Map(files.map((file) => [file, null]));
  for (const [id, list] of owned) for (const file of list) owners.set(file, id);
  return owners;
}

function isIgnored(root, file) {
  const run = spawnSync('git', ['check-ignore', '-q', '--', file], { cwd: root });
  return run.status === 0;
}

/**
 * @param {object} job
 * @param {string} job.root the repo root
 * @param {string} job.source repo-relative file the code leaves
 * @param {string} job.target repo-relative file it goes to
 * @param {string[]} [job.requires] repo-relative files the new module will require
 * @returns {string[]} reasons to refuse, empty when the target is fine
 */
export function targetReasons({ root, source, target, requires = [] }) {
  const reasons = [];
  const home = path.posix.dirname(source);
  const shape = new RegExp(`^${home}/(${KEBAB})/${KEBAB}\\.js$`).exec(target);
  if (!shape) return [`${target} is not ${home}/<feature>/<file>.js in lowercase kebab-case`];
  const feature = shape[1];
  if (frozenTest(root)(target)) reasons.push(`${target} is a frozen path (tools/map/frozen-paths.json)`);
  if (SERVED.has(feature)) reasons.push(`${home}/${feature}/ is served to the browser or holds tests: engine code cannot live there`);
  if (isIgnored(root, target)) reasons.push(`${target} is ignored by git: it would be missing from every install`);
  if (existsSync(path.join(root, home, `${feature}.js`))) {
    reasons.push(`${home}/${feature}.js exists: an update leaves old files behind, so ${feature}.js can never become ${feature}/`);
  }
  if (existsSync(path.join(root, target))) reasons.push(`${target} exists already: give the new module its own file`);
  const owners = ownersOf([target, ...requires]);
  const owner = owners.get(target);
  if (!owner) {
    reasons.push(`no feature owns ${target}: add a pattern for it to tools/map/features.json first (then npm run map)`);
  } else if (SHARED_FEATURES.has(owner)) {
    for (const file of requires) {
      const other = owners.get(file);
      if (other && !SHARED_FEATURES.has(other)) reasons.push(`${target} is shared code (${owner}) and would require ${file} of the feature "${other}"`);
    }
  }
  return reasons;
}
