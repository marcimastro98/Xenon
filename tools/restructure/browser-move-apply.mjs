// Makes the moves browser-move.mjs was asked for: works out every edit first, then writes them, moves the scripts
// with git, gives the map the folder they went into and adds them to the list (browser-moved.json). Nothing is
// written when one edit cannot be placed. No line is left at the old address: it would be a second address for the
// same script. What a step wrote is kept beside the repo's git data until the next step, so `undo` can put it back.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { trackedFiles } from '../quality/repo-files.mjs';
import { findBrowserSites, stops } from './browser-move-refs.mjs';
import { whyNot, withHomes } from './browser-move-plan.mjs';
import { edited, HASHED, readByHand, repoFacts } from './move-apply.mjs';
import { dropUnused, FEATURES, MAP, mapText, pageText } from './move-map.mjs';
import { ownLoads } from './move-plan.mjs';
import { loadsOf } from './move-refs.mjs';

export const MOVED = 'tools/restructure/browser-moved.json';
const NOTE = 'Browser scripts moved whole from the root of server/js/ to the folder of their feature, in order. Written by tools/restructure/browser-move.mjs. The address a page asks for changed with each one (js/x.js -> js/<folder>/x.js) and nothing answers at the old one. The scripts that stay in the root are in browser-move-left.json, each with its reason.';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const reader = (root) => (file) => { try { return readFileSync(path.join(root, file), 'utf8'); } catch { return null; } };

/** @param {string} root @returns {{ note: string, moves: {from: string, to: string}[] }} */
export function readMoved(root) {
  const text = reader(root)(MOVED);
  return text ? JSON.parse(text) : { note: NOTE, moves: [] };
}

const movedText = (list) => `{\n  "note": ${JSON.stringify(list.note)},\n  "moves": [\n${list.moves.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`;

/**
 * Everything a step would do, with nothing written.
 * @param {string} root @param {{from: string, to: string, feature: string}[]} asked @param {any} parser @param {string[]} lists
 * @returns {{ moves: object[], refused: {move: object, why: string[]}[], edits: Map<string, object[]>, bare: object[] }}
 */
export function planStep(root, asked, parser, lists) {
  const repo = repoFacts(root);
  repo.features = withHomes(repo.features, asked);
  const refused = new Map();
  const refuse = (move, why) => refused.set(move.from, { move, why: [...(refused.get(move.from)?.why ?? []), why] });
  for (const move of asked) {
    const why = whyNot(move, repo);
    if (why) refuse(move, why);
  }
  const find = (moves) => findBrowserSites({ files: repo.files, read: repo.read, parser, moves, lists: new Set(lists) });
  let moves = asked.filter((move) => !refused.has(move.from));
  for (const site of find(moves)) {
    // `require('./js/deck')` would find the folder `deck/` where an install still has the old `deck.js` beside it.
    const ownName = site.kind === 'load' && !site.was.endsWith('.js') && path.posix.dirname(site.move.to) === site.move.from.replace(/\.js$/, '');
    const why = ownName ? 'loads it without `.js`, and it would go into the folder of its own name' : stops(site);
    if (why) refuse(site.move, `${site.file}:${site.line} ${why}`);
  }
  moves = moves.filter((move) => !refused.has(move.from));
  const sites = moves.length ? find(moves) : [];
  const moving = new Map(moves.map((move) => [move.from, move]));
  const edits = new Map();
  const add = (file, edit) => edits.set(file, [...(edits.get(file) ?? []), edit]);
  for (const site of sites) {
    // What a moving script loads is spelled below, from its new folder; a relative note in it is left as written.
    if (moving.has(site.file) && (site.kind === 'load' || site.kind === 'relative')) continue;
    if (site.text !== undefined && site.kind !== 'bare') add(site.file, site);
  }
  for (const move of moves) {
    const text = repo.read(move.from);
    for (const load of ownLoads(move, loadsOf(text, parser.parse(text, move.from), parser.K), moves)) add(move.from, load);
  }
  return { moves, refused: [...refused.values()], edits, bare: sites.filter((site) => site.kind === 'bare') };
}

const journalOf = (root) => path.join(path.resolve(root, git(root, ['rev-parse', '--git-dir']).trim()), 'xenon-browser-move-undo.json');

/**
 * Writes a planned step: the edits, the moves, the map, the list.
 * @param {string} root @param {ReturnType<typeof planStep>} step
 * @returns {{ moved: number, edited: number }}
 */
export function applyStep(root, step) {
  const read = reader(root);
  const texts = new Map([...step.edits].map(([file, edits]) => [file, edited(read(file), edits)]));
  for (const [file, text] of texts) {
    if (text.split('\n').length !== read(file).split('\n').length) throw new Error(`${file} would change its number of lines`);
  }
  // The list of statements read by hand keeps the sha256 of files this step edits: made true of the new text.
  const hashes = readByHand(root, step, texts);
  if (hashes) texts.set(HASHED, hashes);
  const list = readMoved(root);
  list.moves.push(...step.moves.map(({ from, to }) => ({ from, to })));
  // The map gets the folder the scripts went into, and loses a pattern that named only scripts now moved.
  const gone = new Set(step.moves.map((move) => move.from));
  const after = trackedFiles(root).filter((file) => !gone.has(file)).concat(step.moves.map((move) => move.to));
  const map = JSON.parse(read(FEATURES));
  const mapped = dropUnused({ ...map, features: withHomes(map.features, step.moves) }, after);
  texts.set(FEATURES, mapText(mapped.map));
  texts.set(MAP, pageText(mapped.map));
  texts.set(MOVED, movedText(list));
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  writeFileSync(journalOf(root), JSON.stringify({ head, moves: step.moves, files: [...texts.keys()], madeList: !existsSync(path.join(root, MOVED)) }));
  for (const [file, text] of texts) writeFileSync(path.join(root, file), text);
  for (let at = 0; at < step.moves.length; at += 1) {
    const { from, to } = step.moves[at];
    mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    git(root, ['mv', from, to]);
  }
  const moving = new Map(step.moves.map((move) => [move.from, move.to]));
  const names = [...texts.keys()].map((file) => moving.get(file) ?? file);
  for (let at = 0; at < names.length; at += 50) git(root, ['add', '--', ...names.slice(at, at + 50)]);
  return { moved: step.moves.length, edited: texts.size };
}

/** Puts back what the last step wrote, as long as nothing was committed since. @returns {string} what happened */
export function undoStep(root) {
  const file = journalOf(root);
  if (!existsSync(file)) return 'no step to undo';
  const journal = JSON.parse(readFileSync(file, 'utf8'));
  if (git(root, ['rev-parse', 'HEAD']).trim() !== journal.head) return 'a commit was made since the step: undo it with git revert';
  for (const { to } of journal.moves) {
    git(root, ['rm', '-q', '-f', '--cached', '--ignore-unmatch', to]);
    rmSync(path.join(root, to), { force: true });
    const folder = path.dirname(path.join(root, to));
    if (existsSync(folder) && !readdirSync(folder).length) rmdirSync(folder);
  }
  for (const name of new Set([...journal.files, ...journal.moves.map((move) => move.from)])) {
    if (name === MOVED && journal.madeList) { git(root, ['rm', '-q', '--cached', '--ignore-unmatch', name]); rmSync(path.join(root, name), { force: true }); continue; }
    writeFileSync(path.join(root, name), execFileSync('git', ['show', `HEAD:${name}`], { cwd: root, maxBuffer: 1 << 28 }));
    git(root, ['add', '--', name]);
  }
  rmSync(file);
  return `${journal.moves.length} moves and ${journal.files.length} files put back`;
}

/**
 * @param {string} root @param {any} parser @param {string[]} lists
 * @returns {string[]} places that still name the old place of a moved script
 */
export function leftovers(root, parser, lists) {
  const { moves } = readMoved(root);
  if (!moves.length) return [];
  const sites = findBrowserSites({ files: trackedFiles(root), read: reader(root), parser, moves, lists: new Set(lists) });
  return sites.filter((site) => site.kind !== 'bare').map((site) => `${site.file}:${site.line} still says ${site.was}`);
}
