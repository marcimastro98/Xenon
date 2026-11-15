// Makes the moves move.mjs was asked for: works out every edit first, then writes them, moves the files with git
// and adds them to the list of moves (moved.json). Nothing is written when one edit cannot be placed. What a step
// wrote is kept beside the repo's git data until the next step, so `undo` can put every file back as HEAD has it.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { trackedFiles } from '../quality/repo-files.mjs';
import { dropUnused, FEATURES, MAP, mapText, pageText, putBack } from './move-map.mjs';
import { ownLoads, whyNot } from './move-plan.mjs';
import { findSites, loadsOf, stops } from './move-refs.mjs';

const posix = path.posix;
export const MOVED = 'tools/restructure/moved.json';
const EXTRACTED = 'tools/restructure/extracted.json';
export const HASHED = 'tools/restructure/load-registrations.json';
const textHash = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const NOTE = 'Files moved whole to the folder of their feature, in order. Written by tools/restructure/move.mjs. `shim` is true while the old path holds its one line that hands on the module; `unshimmed` is true once `move.mjs unshim` took the line away because nothing asks for the old path. The old paths that keep their line are in move-left.json, each with its reason.';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const read = (root) => (file) => { try { return readFileSync(path.join(root, file), 'utf8'); } catch { return null; } };

/** @param {string} root @returns {{ note: string, moves: {from: string, to: string, shim?: true, unshimmed?: true}[] }} */
export function readMoved(root) {
  const text = read(root)(MOVED);
  return text ? JSON.parse(text) : { note: NOTE, moves: [] };
}

const rows = (list) => list.map((row) => `    ${JSON.stringify(row)}`).join(',\n');
const movedText = (list) => `{\n  "note": ${JSON.stringify(list.note)},\n  "moves": [\n${rows(list.moves)}\n  ],\n  "patterns": [\n${rows(list.patterns ?? [])}\n  ]\n}\n`;

/** What the repo says today, for the checks of move-plan.mjs. */
export function repoFacts(root) {
  const tracked = trackedFiles(root);
  const status = git(root, ['status', '--porcelain', '-z']).split('\0').filter(Boolean);
  return {
    tracked: new Set(tracked),
    files: tracked,
    frozen: JSON.parse(readFileSync(path.join(root, 'tools', 'map', 'frozen-paths.json'), 'utf8')),
    features: JSON.parse(readFileSync(path.join(root, 'tools', 'map', 'features.json'), 'utf8')).features,
    dirty: new Set(status.map((line) => line.slice(3))),
    ignored: (file) => { try { git(root, ['check-ignore', '-q', file]); return true; } catch { return false; } },
    read: read(root),
  };
}

// The list of extractions keeps, for a few modules, how a require was spelled before and after: the new spelling
// follows the file it names.
function spelledEdits(root, moves) {
  const text = read(root)(EXTRACTED);
  if (!text) return [];
  const edits = [];
  for (const entry of Object.values(JSON.parse(text).sources ?? {}).flat().filter((one) => one.spelled)) {
    for (const [now, before] of Object.entries(entry.spelled)) {
      const lexical = posix.join(posix.dirname(entry.file), now);
      const move = moves.find((candidate) => candidate.from === lexical || candidate.from === `${lexical}.js`);
      if (!move) continue;
      const pair = `${JSON.stringify(now)}:${JSON.stringify(before)}`;
      const at = text.indexOf(pair);
      if (at < 0 || text.indexOf(pair, at + 1) >= 0) throw new Error(`${EXTRACTED}: the spelling ${pair} of ${entry.file} is not written exactly once`);
      let next = posix.relative(posix.dirname(entry.file), now.endsWith('.js') ? move.to : move.to.replace(/\.js$/, ''));
      if (!next.startsWith('.')) next = `./${next}`;
      edits.push({ file: EXTRACTED, start: at + 1, end: at + 1 + now.length, was: now, text: next });
    }
  }
  return edits;
}

/**
 * Everything a step would do, with nothing written.
 * @param {string} root @param {{from: string, to: string}[]} asked @param {any} parser
 * @returns {{ moves: {from: string, to: string}[], refused: {move: object, why: string[]}[], edits: Map<string, object[]>, sites: object[] }}
 */
export function planStep(root, asked, parser) {
  const repo = repoFacts(root);
  const refused = new Map();
  const refuse = (move, why) => refused.set(move.from, { move, why: [...(refused.get(move.from)?.why ?? []), why] });
  for (const move of asked) {
    const why = whyNot(move, repo);
    if (why) refuse(move, why);
  }
  const find = (moves) => findSites({ files: repo.files, read: repo.read, parser, moves });
  let moves = asked.filter((move) => !refused.has(move.from));
  for (const site of find(moves)) {
    const why = stops(site);
    if (why) refuse(site.move, `${site.file}:${site.line} ${why}`);
  }
  moves = moves.filter((move) => !refused.has(move.from));
  const sites = moves.length ? find(moves) : [];
  const stuck = sites.filter((site) => stops(site));
  if (stuck.length) throw new Error(`a site stops a move only once the others are gone: ${stuck[0].file}:${stuck[0].line}`);
  const moving = new Map(moves.map((move) => [move.from, move]));
  const edits = new Map();
  const add = (file, edit) => edits.set(file, [...(edits.get(file) ?? []), edit]);
  for (const site of sites) if (!(site.kind === 'load' && moving.has(site.file))) add(site.file, site);
  for (const move of moves) {
    const text = repo.read(move.from);
    for (const load of ownLoads(move, loadsOf(text, parser.parse(text, move.from), parser.K), moves)) add(move.from, load);
  }
  for (const edit of spelledEdits(root, moves)) add(edit.file, edit);
  return { moves, refused: [...refused.values()], edits, sites };
}

/** @param {string} text @param {{start: number, end: number, was: string, text: string}[]} edits @returns {string} */
export function edited(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  let floor = Infinity;
  for (const edit of sorted) {
    if (edit.end > floor) throw new Error(`two edits overlap at ${edit.start}`);
    if (out.slice(edit.start, edit.end) !== edit.was) throw new Error(`the text at ${edit.start} is not ${JSON.stringify(edit.was)}`);
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    floor = edit.start;
  }
  return out;
}

// The list of statements read by hand holds the sha256 of each file as it was read, and the first line of each
// statement. A file this step edits differs by the paths it loads alone: an entry that was true of the old text is
// made true of the new one, and a line that loads a moved file is spelled as the file now spells it. A stale entry
// stays stale.
export function readByHand(root, step, texts) {
  const was = texts.get(HASHED) ?? read(root)(HASHED);
  if (!was) return null;
  let hashes = was;
  const placed = new Map(step.moves.map((move) => [move.from, move.to]));
  for (const [file, now] of texts) {
    const before = read(root)(file);
    const name = JSON.stringify(placed.get(file) ?? file);
    hashes = hashes.split(`${name}: "${textHash(before)}"`).join(`${name}: "${textHash(now)}"`);
    for (const edit of (step.edits.get(file) ?? []).filter((one) => one.kind === 'load')) {
      const from = before.lastIndexOf('\n', edit.start) + 1;
      const line = before.slice(from, before.indexOf('\n', edit.start)).replace(/\r$/, '');
      const next = line.slice(0, edit.start - from) + edit.text + line.slice(edit.end - from);
      hashes = hashes.split(`"statement": ${JSON.stringify(line.trim())}`).join(`"statement": ${JSON.stringify(next.trim())}`);
    }
  }
  return hashes === was ? null : hashes;
}

const journalOf = (root) => path.join(path.resolve(root, git(root, ['rev-parse', '--git-dir']).trim()), 'xenon-move-undo.json');

/**
 * Writes a planned step: the edits, the moves, the list.
 * @param {string} root @param {ReturnType<typeof planStep>} step
 * @returns {{ moved: number, edited: number }}
 */
export function applyStep(root, step) {
  const texts = new Map([...step.edits].map(([file, edits]) => [file, edited(read(root)(file), edits)]));
  const list = readMoved(root);
  list.moves.push(...step.moves.map(({ from, to }) => ({ from, to })));
  // A pattern of the map that named only files now moved points at nothing: out, and remembered for `shims`.
  const gone = new Set(step.moves.map((move) => move.from));
  const after = trackedFiles(root).filter((file) => !gone.has(file)).concat(step.moves.map((move) => move.to));
  const mapped = dropUnused(JSON.parse(read(root)(FEATURES)), after);
  if (mapped.dropped.length) {
    list.patterns = [...(list.patterns ?? []), ...mapped.dropped];
    texts.set(FEATURES, mapText(mapped.map));
    texts.set(MAP, pageText(mapped.map));
  }
  const hashes = readByHand(root, step, texts);
  if (hashes) texts.set(HASHED, hashes);
  texts.set(MOVED, movedText(list));
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  writeFileSync(journalOf(root), JSON.stringify({ head, moves: step.moves, files: [...texts.keys()], madeList: !existsSync(path.join(root, MOVED)) }));
  for (const [file, text] of texts) writeFileSync(path.join(root, file), text);
  for (const { from, to } of step.moves) {
    mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    git(root, ['mv', from, to]);
  }
  const moving = new Map(step.moves.map((move) => [move.from, move.to]));
  git(root, ['add', '--', ...[...texts.keys()].map((file) => moving.get(file) ?? file)]);
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
  }
  for (const name of new Set([...journal.files, ...journal.moves.map((move) => move.from)])) {
    if (name === MOVED && journal.madeList) { git(root, ['rm', '-q', '--cached', '--ignore-unmatch', name]); rmSync(path.join(root, name), { force: true }); continue; }
    writeFileSync(path.join(root, name), execFileSync('git', ['show', `HEAD:${name}`], { cwd: root, maxBuffer: 1 << 28 }));
    git(root, ['add', '--', name]);
  }
  rmSync(file);
  return `${journal.moves.length} moves and ${journal.files.length} files put back`;
}

/** The one line an old path keeps, with the sentence that says why it is there. */
export function shimText(move) {
  let spec = posix.relative(posix.dirname(move.from), move.to);
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return `// Moved to ${move.to}. This line hands the same module to anything that still asks for the old place.\nmodule.exports = require('${spec}');\n`;
}

/**
 * Writes the line at every old path of the list that has none yet.
 * @param {string} root @param {boolean} dryRun @returns {string[]} the old paths written
 */
export function writeShims(root, dryRun) {
  const list = readMoved(root);
  const made = [];
  for (const move of list.moves) {
    if (move.shim || move.unshimmed || existsSync(path.join(root, move.from))) continue;
    made.push(move.from);
    if (dryRun) continue;
    writeFileSync(path.join(root, move.from), shimText(move));
    move.shim = true;
  }
  if (!dryRun && made.length) {
    // Each line is a file of its feature again: the patterns that named the old paths go back where they stood.
    const back = putBack(JSON.parse(read(root)(FEATURES)), list.patterns ?? [], trackedFiles(root));
    list.patterns = back.still;
    writeFileSync(path.join(root, FEATURES), mapText(back.map));
    writeFileSync(path.join(root, MAP), pageText(back.map));
    writeFileSync(path.join(root, MOVED), movedText(list));
    git(root, ['add', '--', MOVED, FEATURES, MAP, ...made]);
  }
  return made;
}

/**
 * Takes the line away from every old path that nothing asks for any more.
 * @param {string} root @param {Record<string, string>} keep old paths that keep their line, each with its reason
 * @param {Set<string>} named old paths a file of the repo still names
 * @param {boolean} dryRun
 * @returns {{ gone: string[], kept: {file: string, why: string}[] }}
 */
export function removeShims(root, keep, named, dryRun) {
  const list = readMoved(root);
  const gone = [];
  const kept = [];
  for (const move of list.moves.filter((one) => one.shim)) {
    const why = keep[move.from] ?? (named.has(move.from) ? 'a file of the repo still names it'
      : read(root)(move.from) !== shimText(move) ? 'the file there is not the line the tool wrote' : null);
    if (why) { kept.push({ file: move.from, why }); continue; }
    gone.push(move.from);
    if (dryRun) continue;
    delete move.shim;
    move.unshimmed = true;
  }
  if (!dryRun && gone.length) {
    for (let at = 0; at < gone.length; at += 50) git(root, ['rm', '-q', '-f', '--', ...gone.slice(at, at + 50)]);
    // A pattern of the map that named only those lines points at nothing now, for good.
    const mapped = dropUnused(JSON.parse(read(root)(FEATURES)), trackedFiles(root));
    writeFileSync(path.join(root, FEATURES), mapText(mapped.map));
    writeFileSync(path.join(root, MAP), pageText(mapped.map));
    writeFileSync(path.join(root, MOVED), movedText(list));
    git(root, ['add', '--', MOVED, FEATURES, MAP]);
  }
  return { gone, kept };
}
