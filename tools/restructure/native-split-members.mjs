// Cuts one C# or Swift file by moving whole declarations: a type to a file of its
// own, or members of a big type to another file of the same type (`partial` in C#,
// `extension` in Swift). No member's text changes, except that a Swift member used
// from another file loses `private`, which in Swift stops at the end of the file.

import { cursor, lex, matching } from './native-lex.mjs';
import { bodyItems, fileItems } from './native-items.mjs';

const picked = (item, part) => (part.lines ?? []).some(([from, to]) => item.line >= from && item.line <= to) || (part.items ?? []).includes(item.key);
const noBlankStart = (s) => s.replace(/^(?:[ \t]*\n)+/, '');

/** The words of a piece of code, comments and strings left out. */
function codeWords(text, lang) {
  return new Set(lex(text, lang).filter((token) => token.kind === 'word').map((token) => text.slice(token.start, token.end)));
}

/**
 * @param {object} input
 * @param {string} input.origin repo-relative path @param {string} input.text its text, \n line ends
 * @param {object} input.plan parts: { file, about, types: [names] } or { file, about, type, lines, items }
 * @param {'cs' | 'swift'} input.lang
 * @returns {{ files: Record<string, string>, notes: string[] }}
 */
export function splitMembers({ origin, text, plan, lang }) {
  const { tokens, items } = fileItems(text, lang);
  const c = cursor(text, tokens, tokens.length);
  const notes = [];
  const imports = items.filter((item) => item.kind === 'using' || item.kind === 'import').map((item) => text.slice(item.start, item.end)).join('');
  const namespace = items.find((item) => item.kind === 'namespace' && item.open === undefined);
  const preface = `${imports}${imports && namespace ? '\n' : ''}${namespace ? text.slice(namespace.start, namespace.end) : ''}`;
  const typeNamed = (name) => {
    const found = items.find((item) => item.name === name && item.open !== undefined);
    if (!found) throw new Error(`${origin} has no type called ${name}.`);
    return found;
  };
  /** @type {{ from: number, to: number, with?: string }[]} what leaves the origin, or changes in it */
  const cuts = [];
  /** @type {Record<string, { about: string, pieces: string[], open?: string }>} */
  const made = {};
  const partial = new Set();
  const moved = [];

  for (const part of plan.parts) {
    made[part.file] = { about: part.about, pieces: [] };
    for (const name of part.types ?? []) {
      const item = items.find((candidate) => candidate.key === name || candidate.name === name);
      if (!item) throw new Error(`${origin} has nothing called ${name}.`);
      made[part.file].pieces.push(text.slice(item.lead, item.end));
      cuts.push({ from: item.lead, to: item.end });
      moved.push({ item, file: part.file });
    }
    if (!part.type) continue;
    const type = typeNamed(part.type);
    const members = bodyItems(text, tokens, lang, type).filter((member) => picked(member, part));
    if (members.length === 0) throw new Error(`Nothing goes to ${part.file}: check its lines and items.`);
    for (const member of members) {
      const initialised = member.kind === 'field' && text.slice(member.start, member.end).includes('=');
      if (lang === 'cs' && initialised && !(plan.allowFields ?? []).includes(member.name)) {
        // (taken by a range of lines it simply stays; named outright it is a mistake in the plan)
        if (!(part.items ?? []).includes(member.key)) continue;
        throw new Error(`${member.name} (line ${member.line}) is a field with a starting value: it stays in ${origin}, where the order of such fields is kept.`);
      }
      made[part.file].pieces.push(text.slice(member.lead, member.end));
      cuts.push({ from: member.lead, to: member.end });
      moved.push({ item: member, file: part.file, type: part.type });
    }
    // The line that opens the type again in the new file: its modifiers and name, nothing else.
    let keyword = c.next(tokens.findIndex((token) => token.start >= type.start));
    while (c.str(keyword) === '[' || c.str(keyword) === '@') keyword = c.next((c.str(keyword) === '[' ? matching(text, tokens, keyword) : c.next(keyword + 1)) + 1);
    const first = tokens[keyword].start;
    while (!['class', 'struct', 'interface', 'record', 'enum', 'extension'].includes(c.word(keyword))) keyword = c.next(keyword + 1);
    const nameEnd = tokens[c.next(keyword + 1)].end;
    if (lang === 'cs') {
      const modifiers = text.slice(first, tokens[keyword].start);
      made[part.file].open = `${modifiers}${/\bpartial\b/.test(modifiers) ? '' : 'partial '}${text.slice(tokens[keyword].start, nameEnd)}\n{\n`;
      if (!/\bpartial\b/.test(modifiers) && !partial.has(part.type)) cuts.push({ from: tokens[keyword].start, to: tokens[keyword].start, with: 'partial ' });
      partial.add(part.type);
    } else made[part.file].open = `extension ${part.type} {\n`;
  }

  // Swift only: `private` ends at the file, so a member another file of the split names loses it.
  const widen = new Set(plan.widen ?? []);
  const textOf = (file) => (file === origin ? '' : made[file].pieces.join(''));
  if (lang === 'swift') {
    const everything = items.flatMap((item) => [item, ...(item.open !== undefined && !['func', 'init', 'deinit'].includes(item.kind) ? bodyItems(text, tokens, lang, item) : [])]);
    const fileOf = (item) => moved.find((move) => item.start >= move.item.start && item.end <= move.item.end)?.file ?? origin;
    const stayed = cuts.filter((cut) => cut.with === undefined).sort((a, b) => a.from - b.from);
    let originRest = '';
    let at = 0;
    for (const cut of stayed) { if (cut.from >= at) { originRest += text.slice(at, cut.from); at = cut.to; } }
    originRest += text.slice(at);
    const wordsIn = Object.fromEntries([origin, ...Object.keys(made)].map((file) => [file, codeWords(file === origin ? originRest : textOf(file), lang)]));
    for (const item of everything) {
      if (item.vis !== 'private' && item.vis !== 'fileprivate') continue;
      const home = fileOf(item);
      const elsewhere = Object.keys(wordsIn).some((file) => file !== home && wordsIn[file].has(item.name));
      if (elsewhere || widen.has(item.name)) { widen.add(item.name); notes.push(`${item.name}: "${item.vis}" removed, it is used from another file now.`); }
    }
  }
  const unprivate = (piece) => {
    if (lang !== 'swift' || widen.size === 0) return piece;
    return piece.replace(/^([ \t]*)(?:private|fileprivate) ((?:static |final |lazy |weak )*(?:func|var|let|class|struct|enum|typealias) (\w+))/gm, (all, indent, rest, name) => (widen.has(name) ? `${indent}${rest}` : all));
  };

  const out = {};
  for (const [file, part] of Object.entries(made)) {
    const body = noBlankStart(part.pieces.map(unprivate).join('')).replace(/\s+$/, '\n');
    out[file] = `// ${part.about}\n\n${preface}${preface ? '\n' : ''}${part.open ?? ''}${body}${part.open ? '}\n' : ''}`;
  }
  let rest = '';
  let at = 0;
  for (const cut of cuts.sort((a, b) => a.from - b.from || (a.with ? -1 : 1))) {
    if (cut.from < at) throw new Error(`Two parts take the same lines of ${origin}.`);
    rest += text.slice(at, cut.from) + (cut.with ?? '');
    // A member that stays after one that left keeps an empty line above it.
    const gone = cut.to > cut.from && /^[ \t]*\n/.test(text.slice(cut.from, cut.to)) && !/\n[ \t]*\n$/.test(rest);
    if (gone && !/^(?:[ \t]*\n|[ \t]*\})/.test(text.slice(cut.to)) && !cuts.some((other) => other.from === cut.to && other.to > other.from)) rest += '\n';
    at = cut.to;
  }
  // (when the last type of the file left, the empty line above it goes too)
  out[origin] = unprivate(rest + text.slice(at)).replace(/\n\s*$/, '\n');
  return { files: out, notes };
}
