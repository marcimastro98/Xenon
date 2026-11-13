// Lets a plan move some methods of a big Rust `impl` block, not only the whole block:
// a part with `"members": [{ "impl": "Backend", "lines": ... }]` takes those members, and the
// new file opens the same `impl Backend {` again around them. Each method keeps its
// text; the block's own attributes (a #[cfg]) are repeated on the new block.

import { bodyItems } from './native-items.mjs';
import { mergeWords, wordsOf } from './native-wire.mjs';

const picked = (member, part) => (part.lines ?? []).some(([from, to]) => member.line >= from && member.line <= to) || (part.items ?? []).includes(member.key);

/**
 * @param {string} text @param {import('./native-lex.mjs').Token[]} tokens
 * @param {import('./native-items.mjs').Item[]} items the items of the file
 * @param {{ file: string, members?: { impl: string, lines?: number[][], items?: string[] }[] }[]} parts the plan's parts
 * @returns {object[]} the items, where a block that loses members carries them as `cut`, followed by one
 *   `members` item per part that takes some: `{ kind: 'members', name, part, members, head, cfg }`
 */
export function withMemberGroups(text, tokens, items, parts) {
  const out = [];
  const served = new Set();
  for (const item of items) {
    const takers = item.kind !== 'impl' || item.open === undefined ? [] : parts.flatMap((part, index) => (part.members ?? []).filter((spec) => spec.impl === item.name).map((spec) => ({ part: spec, index })));
    if (takers.length === 0) { out.push(item); continue; }
    const members = bodyItems(text, tokens, 'rust', item);
    const groups = takers.map(({ part, index }) => ({ index, members: members.filter((member) => picked(member, part)) })).filter((group) => group.members.length > 0);
    const cut = groups.flatMap((group) => group.members);
    if (new Set(cut).size !== cut.length) throw new Error(`A member of impl ${item.name} is claimed by two parts.`);
    out.push({ ...item, cut });
    for (const group of groups) {
      served.add(group.index);
      const [first, last] = [group.members[0], group.members[group.members.length - 1]];
      out.push({
        kind: 'members', name: item.name, key: `members ${item.name} ${group.index}`, part: group.index, members: group.members,
        head: text.slice(item.start, tokens[item.open].start).trimEnd(), cfg: item.cfg, vis: '', lead: first.lead, start: first.start, end: last.end,
        line: first.line, lines: group.members.reduce((sum, member) => sum + member.lines, 2),
      });
    }
  }
  parts.forEach((part, index) => {
    if (part.members?.length && !served.has(index)) throw new Error(`${part.file}: no impl block has the members its plan names.`);
  });
  return out;
}

/** The words of an item as the split sees it: a group is its members, a block is what it keeps. */
export function wordsOfItem(text, tokens, item) {
  if (item.kind === 'members') {
    const words = mergeWords(item.members.map((member) => wordsOf(text, tokens, member)));
    for (const name of item.name.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) { words.used.add(name); words.all.add(name); }
    return words;
  }
  if (!item.cut?.length) return wordsOf(text, tokens, item);
  const kept = bodyItems(text, tokens, 'rust', item).filter((member) => !item.cut.some((gone) => gone.start === member.start));
  return mergeWords([wordsOf(text, tokens, { start: item.start, end: tokens[item.open].start }), ...kept.map((member) => wordsOf(text, tokens, member))]);
}

/**
 * The text of an item with the members it lost left out and visibility put in.
 * @param {string} text @param {object} item @param {Map<number, string>} inserts offset -> what goes in before it
 * @returns {string}
 */
export function textOfItem(text, item, inserts = new Map()) {
  const span = (from, to) => {
    let out = '';
    let at = from;
    for (const offset of [...inserts.keys()].filter((o) => o >= from && o < to).sort((a, b) => a - b)) {
      out += text.slice(at, offset) + inserts.get(offset);
      at = offset;
    }
    return out + text.slice(at, to);
  };
  if (item.kind === 'members') {
    const body = item.members.map((member) => span(member.lead, member.end)).join('').replace(/^(?:[ \t]*\n)+/, '');
    return `\n${item.head} {\n${body.replace(/\s+$/, '')}\n}\n`;
  }
  let out = '';
  let at = item.lead;
  for (const gone of [...(item.cut ?? [])].sort((a, b) => a.start - b.start)) {
    out += span(at, gone.lead);
    at = gone.end;
  }
  return out + span(at, item.end);
}
