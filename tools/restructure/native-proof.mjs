// Proves a split moved code and changed none: every item a file had before is found
// again, character for character, in the file or in one of the files cut out of it.
// The one difference allowed is a wider visibility (`pub(super)` in Rust, a dropped
// `private` in Swift), which is counted. `use`, `mod` and `import` lines are not
// compared: they are the wiring, and the compiler checks them.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cursor, langOf, lex, matching } from './native-lex.mjs';
import { bodyItems, fileItems } from './native-items.mjs';
import { readLedger } from './native-split.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIRING = new Set(['use', 'inner', 'extern crate', 'using', 'namespace', 'import']);
const HOLDS_MEMBERS = new Set(['type', 'class', 'struct', 'enum', 'extension', 'actor']);
const VIS = '\u0001';
const trim = (s) => `${s.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')}\n`;

/**
 * One item with its visibility words replaced by a mark, and the words themselves.
 * @param {string} raw @param {import('./native-lex.mjs').Lang} lang
 * @returns {{ plain: string, vis: string[] }}
 */
export function withoutVisibility(raw, lang) {
  if (lang === 'cs') return { plain: raw, vis: [] };
  const tokens = lex(raw, lang);
  const c = cursor(raw, tokens, tokens.length);
  const vis = [];
  let plain = '';
  let at = 0;
  for (let k = 0; k < tokens.length; k += 1) {
    const w = c.word(k);
    const isVis = lang === 'rust' ? w === 'pub' : (w === 'private' || w === 'fileprivate') && c.str(c.next(k + 1)) !== '(';
    if (!isVis) continue;
    const paren = c.next(k + 1);
    const last = lang === 'rust' && c.str(paren) === '(' && ['crate', 'super', 'self', 'in'].includes(c.word(c.next(paren + 1))) ? matching(raw, tokens, paren) : k;
    vis.push(raw.slice(tokens[k].start, tokens[last].end).replace(/\s+/g, ''));
    const next = tokens[last + 1];
    plain += raw.slice(at, tokens[k].start) + VIS;
    at = next?.kind === 'space' ? next.end : tokens[last].end;
    k = last;
  }
  return { plain: plain + raw.slice(at), vis };
}

const RANK = (lang) => (word) => (lang === 'swift' ? (word === 'private' ? 0 : word === 'fileprivate' ? 1 : 2) : word === '' ? 0 : word === 'pub' ? 3 : word === 'pub(crate)' ? 2 : 1);

/**
 * @param {string} before @param {string} after two versions of one item
 * @param {import('./native-lex.mjs').Lang} lang
 * @returns {{ same: boolean, wider: number }} same text apart from visibility, and how many places got wider (never narrower)
 */
export function sameItem(before, after, lang) {
  const a = withoutVisibility(before, lang);
  const b = withoutVisibility(after, lang);
  if (a.plain.replaceAll(VIS, '') !== b.plain.replaceAll(VIS, '')) return { same: false, wider: 0 };
  // Walk both texts: at each place one of them has a visibility, the newer one may only be wider.
  const rank = RANK(lang);
  const open = lang === 'swift' ? 'internal' : '';
  let i = 0;
  let j = 0;
  let wider = 0;
  const [x, y] = [a.plain, b.plain];
  const [vx, vy] = [[...a.vis], [...b.vis]];
  while (i < x.length || j < y.length) {
    const was = x[i] === VIS ? vx.shift() : open;
    const now = y[j] === VIS ? vy.shift() : open;
    if (x[i] === VIS) i += 1;
    if (y[j] === VIS) j += 1;
    if (rank(now) < rank(was)) return { same: false, wider: 0 };
    if (rank(now) > rank(was)) wider += 1;
    if (x[i] !== VIS && y[j] !== VIS) { i += 1; j += 1; }
  }
  return { same: true, wider };
}

/**
 * The items of one file as the proof compares them: members of a type one by one
 * (so a type may be spread over files), everything else whole.
 * @param {string} text @param {import('./native-lex.mjs').Lang} lang
 * @returns {{ items: { key: string, raw: string }[], comments: string[], heads: { name: string, text: string }[] }}
 */
export function proofItems(text, lang) {
  const { tokens, items } = fileItems(text, lang);
  const out = [];
  const heads = [];
  for (const item of items) {
    if (WIRING.has(item.kind) || (item.kind === 'mod' && item.open === undefined)) continue;
    const spread = lang !== 'rust' && HOLDS_MEMBERS.has(item.kind) && item.open !== undefined && !(lang === 'cs' && item.kind === 'enum');
    if (!spread) { out.push({ key: item.key, raw: trim(text.slice(item.lead, item.end)) }); continue; }
    heads.push({ name: item.name, text: text.slice(item.lead, tokens[item.open].start).replace(/\bpartial\s+/, '').replace(/\s+/g, ' ').trim() });
    for (const member of bodyItems(text, tokens, lang, item)) out.push({ key: `${item.name} ${member.key}`, raw: `${item.name}\n${trim(text.slice(member.lead, member.end))}` });
  }
  const comments = tokens.filter((token) => token.kind === 'comment').map((token) => text.slice(token.start, token.end).trim());
  return { items: out, comments, heads };
}

/**
 * @param {Record<string, string>} before file -> text of the group before the split
 * @param {Record<string, string>} after file -> text now
 * @returns {{ problems: string[], items: number, wider: number }}
 */
export function compareGroups(before, after) {
  const problems = [];
  const read = (group) => Object.entries(group).map(([file, text]) => ({ file, ...proofItems(text, langOf(file)) }));
  const [was, now] = [read(before), read(after)];
  const lang = langOf(Object.keys(after)[0]);
  const pool = new Map();
  const plainOf = (raw) => withoutVisibility(raw, lang).plain.replaceAll(VIS, '');
  for (const file of was) for (const item of file.items) {
    const key = plainOf(item.raw);
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push({ ...item, file: file.file });
  }
  let count = 0;
  let wider = 0;
  for (const file of now) for (const item of file.items) {
    const match = pool.get(plainOf(item.raw))?.shift();
    if (!match) { problems.push(`${file.file}: "${item.key}" is not an item the files had before, or its text changed.`); continue; }
    const verdict = sameItem(match.raw, item.raw, lang);
    if (!verdict.same) problems.push(`${file.file}: "${item.key}" lost visibility it had in ${match.file}.`);
    count += 1;
    wider += verdict.wider;
  }
  for (const left of pool.values()) for (const item of left) problems.push(`${item.file}: "${item.key}" is gone.`);
  // Comments: every one from before is still somewhere (new files may add their first line).
  const kept = new Map();
  for (const file of now) for (const comment of file.comments) kept.set(comment, (kept.get(comment) ?? 0) + 1);
  for (const file of was) for (const comment of file.comments) {
    if (!kept.get(comment)) problems.push(`${file.file}: a comment is gone: ${comment.slice(0, 70)}`);
    else kept.set(comment, kept.get(comment) - 1);
  }
  // A type opened again in another file must be the same type: its first line may only be shorter.
  const firstHeads = new Map(was.flatMap((file) => file.heads).map((head) => [head.name, head.text]));
  for (const file of now) for (const head of file.heads) {
    const full = firstHeads.get(head.name);
    const bare = head.text.replace(/^(?:\/\/[^\n]*\s*)+/, '');
    const reopened = full !== undefined && (full === head.text || full.includes(bare) || bare === `extension ${head.name}`);
    if (!reopened) problems.push(`${file.file}: the type ${head.name} is declared differently than before.`);
  }
  return { problems, items: count, wider };
}

/** @param {string} base the commit to compare the working folder with @returns {number} exit code */
export function runProof(base) {
  const show = (file) => {
    try { return execFileSync('git', ['show', `${base}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r\n/g, '\n'); } catch { return null; }
  };
  let failed = 0;
  let groups = 0;
  for (const [origin, parts] of Object.entries(readLedger())) {
    const before = {};
    const after = {};
    for (const file of [origin, ...parts]) {
      const old = show(file);
      if (old !== null) before[file] = old;
      if (fs.existsSync(path.join(ROOT, file))) after[file] = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    }
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    groups += 1;
    const { problems, items, wider } = compareGroups(before, after);
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${origin}: ${items} items found again in ${Object.keys(after).length} files, ${wider} with a wider visibility`);
    for (const problem of problems) console.log(`       ${problem}`);
    failed += problems.length;
  }
  console.log(failed ? `${failed} differences: this is not a pure move.` : `Pure moves: ${groups} split files compared with ${base}, every item and comment is still there.`);
  return failed ? 1 : 0;
}
