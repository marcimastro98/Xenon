// Keeps the two reviewed lists (load-registrations.json, after-load.json) true after a move.
// An entry of those lists pins the files a person read by the SHA-256 of their text, and
// stops counting when one changes. A move the replay has proven changes no word of what was
// read: the same lines are in the file and in the modules taken out of it. For such a file
// `relist` records the new fingerprint and pins the new modules next to it, because part of
// what was read lives there now. Everything else is refused, and a person reads the file
// again: a hand edit (so also a change to the very function the entry is about), a rewrite
// (`state`, `lift`, `paths`), or a file that was not the text that was read before the move.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { gitShow, replay } from './extract.mjs';
import { readLedger } from './ledger.mjs';
import { textHash } from './load-registrations.mjs';

// Each list, the key of an entry that holds its pinned files, and what names an entry to a person.
export const PINNED_LISTS = [
  { list: 'tools/restructure/load-registrations.json', key: 'callees', label: (entry) => entry.statement },
  { list: 'tools/restructure/after-load.json', key: 'read', label: (entry) => entry.name },
];

/**
 * @param {(file: string) => string} read reads a repo-relative file
 * @returns {{ list: string, key: string, json: any, text: string }[]} the lists that are there
 */
function readLists(read) {
  const lists = [];
  for (const { list, key } of PINNED_LISTS) {
    let text = null;
    try { text = read(list); } catch { /* a repo without the list pins nothing through it */ }
    if (text !== null) lists.push({ list, key, json: JSON.parse(text), text });
  }
  return lists;
}

/**
 * Every pinned file of both lists.
 * @param {(file: string) => string} read reads a repo-relative file
 * @returns {{ list: string, file: string, entry: string, pinned: string, hash: string }[]} `file` is the file the entry is
 *   about, `entry` its statement or function, `pinned` the file that was read
 */
export function pinsOf(read) {
  const pins = [];
  for (const { list, key, json } of readLists(read)) {
    const label = PINNED_LISTS.find((known) => known.list === list).label;
    for (const [file, entries] of Object.entries(json.files ?? {})) {
      for (const entry of entries) {
        for (const [pinned, hash] of Object.entries(entry[key] ?? {})) pins.push({ list, file, entry: String(label(entry) ?? ''), pinned, hash });
      }
    }
  }
  return pins;
}

/**
 * What to say before code is taken out of files: the ones a list pins lose their entry until `relist` runs.
 * @param {string[]} sources repo-relative files a plan takes code from
 * @param {(file: string) => string} read
 * @returns {string[]} one line per pinned file, none when no list knows them
 */
export function pinWarnings(sources, read) {
  const pins = pinsOf(read);
  return [...new Set(sources)].flatMap((source) => {
    const held = pins.filter((pin) => pin.pinned === source);
    if (held.length === 0) return [];
    const by = [...new Set(held.map((pin) => `${pin.list} ("${pin.entry}" of ${pin.file})`))].join(', ');
    return [`Warning: ${source} is a file that was read for ${by}. Taking code out of it changes its fingerprint and the entry stops `
      + 'counting. After the move: node tools/restructure/cli.mjs verify, then node tools/restructure/cli.mjs relist.'];
  });
}

/**
 * Works out the new fingerprints, or why there are none. Pure: everything it reads is handed in.
 * @param {object} job
 * @param {(file: string) => string} job.read reads a repo-relative file as it is on disk
 * @param {(file: string) => string | null} job.show the same file at the base revision, null when it had none
 * @param {{ sources: Record<string, { file: string, state?: any, lift?: boolean, paths?: boolean }[]> }} job.ledger extracted.json
 * @param {string[]} job.problems what the replay from the base revision found: any problem refuses everything
 * @param {string} job.base the name of the base revision, for the messages
 * @returns {{ changes: { pinned: string, was: string, now: string, modules: { file: string, hash: string }[], lists: string[] }[], refusals: string[] }}
 */
export function planRelist({ read, show, ledger, problems, base }) {
  const stale = new Map();
  for (const pin of pinsOf(read)) {
    let text = null;
    try { text = read(pin.pinned); } catch { /* said below */ }
    if (text !== null && textHash(text) === pin.hash) continue;
    const known = stale.get(pin.pinned) ?? { pinned: pin.pinned, text, hashes: new Set(), lists: new Set() };
    known.hashes.add(pin.hash);
    known.lists.add(pin.list);
    stale.set(pin.pinned, known);
  }
  const changes = [];
  const refusals = [];
  if (stale.size && problems.length) {
    return { changes, refusals: [`the moves since ${base} are not proven, so no fingerprint is recorded again (node tools/restructure/cli.mjs verify --base ${base}):`,
      ...problems.slice(0, 8).map((problem) => `  ${problem}`)] };
  }
  for (const { pinned, text, hashes, lists } of stale.values()) {
    const refuse = (why) => refusals.push(`${pinned}: ${why}. Read the file again, then update its sha256 by hand.`);
    if (text === null) { refuse('it is pinned and cannot be read'); continue; }
    const before = show(pinned);
    if (before === null) { refuse(`${base} has no such file`); continue; }
    if (hashes.size !== 1 || !hashes.has(textHash(before))) { refuse(`at ${base} it was already not the text that was read: it changed by hand before any move`); continue; }
    const made = (ledger.sources[pinned] ?? []).filter((entry) => show(entry.file) === null);
    if (made.length === 0) { refuse(`it differs from ${base} and no move out of it is recorded: it changed by hand`); continue; }
    const rewritten = made.filter((entry) => entry.state || entry.lift || entry.paths);
    if (rewritten.length) { refuse(`${rewritten.map((entry) => entry.file).join(', ')} came out of it by a rewrite, which changes the words that were read`); continue; }
    changes.push({ pinned, was: [...hashes][0], now: textHash(text), lists: [...lists],
      modules: made.map((entry) => ({ file: entry.file, hash: textHash(read(entry.file)) })) });
  }
  return { changes, refusals };
}

/**
 * The text of a list with the changes written in: the pinned file gets its new fingerprint, and each module taken out
 * of it follows it in every entry that pins it.
 * @param {string} text the list as it is
 * @param {string} key 'callees' or 'read'
 * @param {ReturnType<typeof planRelist>['changes']} changes
 * @returns {string} the new text, the same text when nothing in it changes
 */
export function relistText(text, key, changes) {
  const json = JSON.parse(text);
  if (`${JSON.stringify(json, null, 2)}\n` !== text) throw new Error('the list is not written the way this tool writes it (JSON, two spaces): record the fingerprints by hand');
  const byFile = new Map(changes.map((change) => [change.pinned, change]));
  for (const entries of Object.values(json.files ?? {})) {
    for (const entry of entries) {
      const pairs = Object.entries(entry[key] ?? {});
      if (!pairs.some(([file]) => byFile.has(file))) continue;
      const next = {};
      for (const [file, hash] of pairs) {
        const change = byFile.get(file);
        next[file] = change ? change.now : hash;
        for (const module of change?.modules ?? []) next[module.file] = module.hash;
      }
      entry[key] = next;
    }
  }
  return `${JSON.stringify(json, null, 2)}\n`;
}

/**
 * The command: redo the moves from the base revision, and when they are proven record the fingerprints again.
 * @param {{ root: string, parser: any, base: string, dryRun?: boolean, show?: (root: string, rev: string, file: string) => string | null }} job
 * @returns {{ changes: ReturnType<typeof planRelist>['changes'], refusals: string[], written: string[] }}
 */
export function relist({ root, parser, base, dryRun = false, show = gitShow }) {
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const { problems } = replay({ root, parser, base, show });
  const plan = planRelist({ read, show: (file) => show(root, base, file), ledger: readLedger(root), problems, base });
  const written = [];
  if (plan.refusals.length || plan.changes.length === 0) return { ...plan, written };
  for (const { list, key, text } of readLists(read)) {
    const next = relistText(text, key, plan.changes);
    if (next === text) continue;
    written.push(list);
    if (!dryRun) writeFileSync(path.join(root, list), next);
  }
  return { ...plan, written };
}

/** @param {ReturnType<typeof relist>} done @param {{ base: string, dryRun?: boolean }} how @returns {{ lines: string[], code: number }} */
export function renderRelist(done, { base, dryRun = false }) {
  if (done.refusals.length) return { lines: ['Refused:', ...done.refusals.map((line) => `  ${line}`)], code: 1 };
  if (done.changes.length === 0) return { lines: ['Nothing to record: every pinned file is the text that was read.'], code: 0 };
  const lines = [`${dryRun ? 'Would record' : 'Recorded'} again in ${done.written.join(' and ')}, after the moves redone from ${base} gave the files on disk byte for byte:`];
  for (const change of done.changes) {
    lines.push(`  ${change.pinned}: ${change.was.slice(0, 12)} -> ${change.now.slice(0, 12)}`
      + `, and pinned with it ${change.modules.map((module) => module.file).join(', ')}`);
  }
  return { lines, code: 0 };
}

/**
 * Runs the command and says what it did.
 * @param {{ root: string, parser: any, base: string, dryRun?: boolean }} job
 * @returns {number} the exit code: 1 when a fingerprint was refused
 */
export function runRelist(job) {
  const { lines, code } = renderRelist(relist(job), job);
  for (const line of lines) (code ? console.error : console.log)(line);
  return code;
}
