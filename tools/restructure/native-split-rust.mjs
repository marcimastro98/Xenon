// Cuts one Rust file into a parent and child modules by moving whole items. An item's
// text never changes, except that one used from another file gains `pub(super)`.
// The `use` and `mod` lines are written new: each file imports what its items name.

import path from 'node:path';
import { cursor, matching } from './native-lex.mjs';
import { bodyItems, fileItems } from './native-items.mjs';
import { textOfItem, withMemberGroups, wordsOfItem } from './native-split-impl.mjs';
import { boundName, deeperPath, useLeaves, writeUses } from './native-use.mjs';
import { callsTrait, commonCfg, coversEverything, mergeWords, namesAbove, wordsOf } from './native-wire.mjs';

const NAMED = new Set(['fn', 'struct', 'enum', 'union', 'trait', 'type', 'const', 'static', 'mod', 'macro']);
const STAYS = (item) => item.kind === 'use' || item.kind === 'inner' || item.kind === 'extern crate' || (item.kind === 'mod' && item.open === undefined);
const union = (...lists) => [...new Set(lists.flat())];
const MACRO_STATIC = /\bstatic\s+(?:mut\s+)?([A-Z_][A-Z0-9_]*)\s*:/g;

/** Which part an item goes to: the index in plan.parts, or -1 to stay. */
function assign(items, parts) {
  for (const part of parts) {
    for (const key of part.items ?? []) if (!items.some((item) => item.key === key)) throw new Error(`${part.file}: no item is called "${key}".`);
  }
  return items.map((item) => {
    if (item.kind === 'members') return item.part;
    if (STAYS(item)) return -1;
    const hits = parts.flatMap((part, index) => {
      const byLine = (part.lines ?? []).some(([from, to]) => item.line >= from && item.line <= to);
      return (byLine && !(part.except ?? []).includes(item.key)) || (part.items ?? []).includes(item.key) ? [index] : [];
    });
    if (hits.length > 1) throw new Error(`"${item.key}" (line ${item.line}) is claimed by two parts.`);
    return hits[0] ?? -1;
  });
}

/** The private fields of a struct: name and where `pub(super)` would go. */
function privateFields(text, tokens, item) {
  if (item.kind !== 'struct' || item.open === undefined) return [];
  const c = cursor(text, tokens, item.close);
  const fields = [];
  for (let k = c.next(item.open + 1); k < item.close;) {
    while (c.str(k) === '#') k = c.next(matching(text, tokens, c.next(k + 1)) + 1);
    if (c.word(k) && c.word(k) !== 'pub') fields.push({ name: c.word(k), at: tokens[k].start });
    const comma = c.find(k, (t) => t === ',');
    if (comma < 0) break;
    k = c.next(comma + 1);
  }
  return fields;
}

/**
 * @param {object} input
 * @param {string} input.origin repo-relative path of the file to cut
 * @param {string} input.text its text, \n line ends
 * @param {object} input.plan parts (file, about, lines, items) and the corrections widen, uses, drop, keep, traits
 * @param {Set<string>} input.otherWords every word of the crate's other files: who may name a moved item from outside
 * @param {import('./native-wire.mjs').Words} [input.siblingWords] the words of the files an earlier split cut out of this one: they reach its items through it
 * @returns {{ files: Record<string, string>, notes: string[] }}
 */
export function splitRust({ origin, text, plan, otherWords, siblingWords = mergeWords([]) }) {
  const { tokens, items: read, header, trailer } = fileItems(text, 'rust');
  const items = withMemberGroups(text, tokens, read, plan.parts);
  const notes = [];
  const base = path.posix.basename(origin);
  const isRoot = base === 'lib.rs' || base === 'main.rs';
  const partDir = isRoot || base === 'mod.rs' ? path.posix.dirname(origin) : origin.replace(/\.rs$/, '');
  const up = isRoot ? ['crate'] : ['super'];
  const widenTo = isRoot ? 'pub(crate)' : 'pub(super)';
  const modOf = plan.parts.map((part) => {
    if (path.posix.dirname(part.file) !== partDir) throw new Error(`${part.file} must sit in ${partDir}/ to be a child module of ${origin}.`);
    return path.posix.basename(part.file, '.rs');
  });
  const where = assign(items, plan.parts);
  const words = items.map((item) => wordsOfItem(text, tokens, item));
  const files = [-1, ...plan.parts.map((_, index) => index)];
  const inFile = (f) => items.map((item, i) => ({ item, i })).filter(({ i }) => where[i] === f);
  const moving = (f) => inFile(f).filter(({ item }) => !STAYS(item));
  const fileWords = new Map(files.map((f) => [f, mergeWords(moving(f).map(({ i }) => words[i]))]));
  const gate = new Map(files.map((f) => [f, f < 0 ? [] : commonCfg(moving(f).map(({ item }) => item.cfg))]));
  for (const f of files) if (f >= 0 && moving(f).length === 0) throw new Error(`Nothing goes to ${plan.parts[f].file}: check its lines and items.`);

  const defs = new Map();
  const define = (name, def) => defs.set(name, [...(defs.get(name) ?? []), def]);
  items.forEach((item, i) => {
    if (NAMED.has(item.kind) && item.name) define(item.name, { item, i, file: where[i] });
    // thread_local! and its like declare statics inside a macro, where no visibility can be added.
    if (item.kind === 'call') for (const found of text.slice(item.start, item.end).matchAll(MACRO_STATIC)) define(found[1], { item, i, file: where[i], macro: true });
  });
  const leaves = items.flatMap((item) => (item.kind !== 'use' ? [] : useLeaves(item.name).map((leaf) => ({ leaf, item }))));
  const usedByName = mergeWords(items.map((item, i) => (item.kind === 'use' ? mergeWords([]) : words[i]))).used;
  const isTraitLike = ({ leaf }) => leaf.name !== '*' && (leaf.alias === '_' || !usedByName.has(boundName(leaf)));
  const localNames = new Set([...defs.keys(), ...leaves.map(({ leaf }) => boundName(leaf))]);
  const deeper = (leaf) => {
    const whole = leaf.name === '*' || leaf.name === 'self' ? leaf.path : [...leaf.path, leaf.name];
    const moved = deeperPath(whole, localNames, up);
    return leaf.name === '*' || leaf.name === 'self' ? { ...leaf, path: moved } : { ...leaf, path: moved.slice(0, -1) };
  };
  const dropped = (f, name) => (plan.drop?.[f < 0 ? origin : plan.parts[f].file] ?? []).includes(name);
  const userCfg = (f, name) => commonCfg(moving(f).filter(({ i }) => words[i].used.has(name)).map(({ item }) => item.cfg));
  const widened = new Set(plan.widen ?? []);
  // `super::name` in an item that moves one module down must find the same thing: the parent imports the name.
  const above = new Map();
  items.forEach((item, i) => {
    if (where[i] < 0 || item.kind === 'mod') return;
    for (const name of (item.members ?? [item]).flatMap((one) => [...namesAbove(text, tokens, one)])) {
      if (localNames.has(name)) throw new Error(`"${item.key}" names super::${name}, and ${origin} has a ${name} of its own: moved, it would mean that one.`);
      above.set(name, [...(above.get(name) ?? []), item.cfg]);
    }
  });

  /** The imports file `f` needs for names that live in another file of the split. */
  const importsFor = (f) => {
    const out = [];
    const mine = new Set([...defs].filter(([, list]) => list.some((def) => def.file === f)).map(([name]) => name));
    const need = f < 0 ? new Set([...fileWords.get(f).used, ...siblingWords.used]) : fileWords.get(f).used;
    for (const name of [...need].sort()) {
      if (mine.has(name) || dropped(f, name)) continue;
      const found = (defs.get(name) ?? []).filter((def) => def.file !== f);
      for (const g of new Set(found.map((def) => def.file))) {
        const variants = found.filter((def) => def.file === g);
        const cfgs = coversEverything(variants.map((def) => def.item.cfg)) ? [[]] : variants.map((def) => def.item.cfg);
        const vis = variants[0].macro ? '' : variants[0].item.vis;
        if (g >= 0 && variants[0].macro) throw new Error(`${name} is declared inside a macro in ${plan.parts[g].file} and used from another file: leave that macro in ${origin}.`);
        if (g >= 0 && !vis) widened.add(name);
        const from = f < 0 ? [modOf[g]] : g < 0 ? up : [...up, modOf[g]];
        for (const cfg of cfgs) {
          out.push({ cfg: union(cfg, gate.get(g), userCfg(f, name)).filter((line) => !gate.get(f).includes(line)), vis: f < 0 && vis && otherWords.has(name) ? vis : '', leaf: { path: from, name } });
        }
      }
      if (found.length === 0 && f >= 0) {
        for (const { leaf, item } of leaves.filter((entry) => boundName(entry.leaf) === name)) {
          out.push({ cfg: union(item.cfg, userCfg(f, name)).filter((line) => !gate.get(f).includes(line)), vis: '', leaf: deeper(leaf) });
        }
      }
    }
    if (f < 0) {
      for (const [name, cfgs] of above) out.push({ cfg: commonCfg(cfgs), vis: '', leaf: { path: ['super'], name } });
      // Names nothing in this file uses any more, but another module of the crate still reaches through it.
      for (const [name, list] of defs) {
        const def = list[0];
        if (def.file >= 0 && !def.macro && def.item.vis && !need.has(name) && otherWords.has(name) && !dropped(f, name)) out.push({ cfg: union(def.item.cfg), vis: def.item.vis, leaf: { path: [modOf[def.file]], name } });
      }
      return out;
    }
    for (const entry of leaves) {
      const { leaf, item } = entry;
      const label = leaf.name === '*' ? `${leaf.path.join('::')}::*` : boundName(leaf) === '_' ? leaf.name : boundName(leaf);
      if (dropped(f, label)) continue;
      const cfg = item.cfg.filter((line) => !gate.get(f).includes(line));
      if (leaf.name === '*') {
        if (item.cfg.every((line) => moving(f).some((m) => m.item.cfg.includes(line)))) out.push({ cfg, vis: '', leaf: deeper(leaf) });
      } else if (isTraitLike(entry) && !item.vis) {
        // (a `pub use` nothing here names is a re-export of the parent, not an import for methods)
        const calls = callsTrait(leaf.name, fileWords.get(f), plan.traits);
        if (calls === null) notes.push(`${plan.parts[f].file}: "${leaf.name}" is imported for its methods and is not in the trait list; imported here to be safe.`);
        // Under the cfg of the items that call it: a trait only a Linux function needs is unused elsewhere.
        const callers = commonCfg(moving(f).filter(({ i }) => callsTrait(leaf.name, words[i], plan.traits)).map((m) => m.item.cfg));
        if (calls !== false) out.push({ cfg: union(cfg, calls ? callers.filter((line) => !gate.get(f).includes(line)) : []), vis: '', leaf: deeper(leaf) });
      }
    }
    return out;
  };

  const imports = new Map(files.map((f) => [f, importsFor(f)]));
  const extra = (f) => (plan.uses?.[f < 0 ? origin : plan.parts[f].file] ?? []).map((line) => `${line}\n`).join('');

  // Visibility: an item, field or method used from another file of the split gets pub(super),
  // and so does a private type that such an item hands out (its signature names it).
  const inserts = new Map();
  const others = (f) => mergeWords([siblingWords, ...files.filter((g) => g !== f).map((g) => fileWords.get(g))]);
  const signature = (item) => wordsOf(text, tokens, { start: item.start, end: item.kind === 'fn' && item.open !== undefined ? tokens[item.open].start : item.end }).all;
  const shown = new Map(files.map((f) => [f, []]));
  items.forEach((item, i) => {
    const f = where[i];
    if (f < 0) return;
    const seen = others(f);
    for (const field of privateFields(text, tokens, item)) {
      const lexical = seen.dotted.has(field.name) || (seen.all.has(item.name) && seen.bound.has(field.name));
      if (lexical || widened.has(`${item.name}.${field.name}`)) inserts.set(field.at, `${widenTo} `);
    }
    const inherent = item.kind === 'impl' && !item.name.includes(' for ');
    const members = item.kind === 'members' ? item.members : inherent ? bodyItems(text, tokens, 'rust', item).filter((member) => !(item.cut ?? []).some((gone) => gone.start === member.start)) : [];
    for (const member of members) {
      if (!['fn', 'const', 'type'].includes(member.kind)) continue;
      const lexical = seen.dotted.has(member.name) || (seen.pathed.has(member.name) && seen.all.has(item.name.replace(/<.*$/, '')));
      if (!member.vis && (lexical || widened.has(`${item.name}::${member.name}`))) inserts.set(member.visAt, `${widenTo} `);
      if (member.vis || inserts.has(member.visAt)) shown.get(f).push(signature(member));
    }
  });
  const TYPES = new Set(['struct', 'enum', 'union', 'type', 'trait']);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of files.filter((g) => g >= 0)) {
      const mine = moving(f).map(({ item }) => item).filter((item) => NAMED.has(item.kind));
      const exposed = new Set([...shown.get(f), ...mine.filter((item) => item.vis || widened.has(item.name)).map(signature)].flatMap((set) => [...set]));
      for (const item of mine) {
        if (TYPES.has(item.kind) && !item.vis && !widened.has(item.name) && exposed.has(item.name)) { widened.add(item.name); grew = true; }
      }
    }
  }
  items.forEach((item, i) => {
    if (where[i] >= 0 && NAMED.has(item.kind) && !item.vis && widened.has(item.name)) inserts.set(item.visAt, `${widenTo} `);
  });
  const render = (item, first) => (first ? textOfItem(text, item, inserts).replace(/^(?:[ \t]*\n)+/, '') : textOfItem(text, item, inserts));

  /** A `use` item of the parent with the names nothing there uses any more taken out. */
  const pruned = (item) => {
    const own = leaves.filter((entry) => entry.item === item);
    const rest = fileWords.get(-1);
    const stays = (entry) => {
      const name = boundName(entry.leaf);
      if (item.vis || entry.leaf.name === '*' || (plan.keep ?? []).includes(name)) return true;
      if (isTraitLike(entry)) return callsTrait(entry.leaf.name, rest, plan.traits) !== false;
      return rest.used.has(name);
    };
    // What only code of another system still uses is imported under that cfg, or this one warns of an unused import.
    const cfgOf = (entry) => {
      const name = boundName(entry.leaf);
      if (item.vis || entry.leaf.name === '*' || (plan.keep ?? []).includes(name)) return item.cfg;
      const users = moving(-1).filter(({ i }) => (isTraitLike(entry) ? callsTrait(entry.leaf.name, words[i], plan.traits) : words[i].used.has(name)));
      return union(item.cfg, commonCfg(users.map((user) => user.item.cfg)));
    };
    const kept = own.filter(stays);
    if (kept.length === own.length && kept.every((entry) => cfgOf(entry).length === item.cfg.length)) return text.slice(item.lead, item.end);
    if (kept.length === 0) return '';
    const onlyCfg = text.slice(item.start, item.visAt).replace(/#\s*\[\s*cfg\s*\([^\n]*\)\s*\]\s*/g, '').trim() === '';
    if (!onlyCfg) { notes.push(`${origin}: the use at line ${item.line} has its own attributes and was left whole.`); return text.slice(item.lead, item.end); }
    return text.slice(item.lead, item.start) + writeUses(kept.map((entry) => ({ cfg: cfgOf(entry), vis: item.vis, leaf: entry.leaf })));
  };

  const out = {};
  plan.parts.forEach((part, f) => {
    const body = moving(f).map(({ item }, n) => render(item, n === 0)).join('');
    const uses = writeUses(imports.get(f), part.compact) + extra(f);
    out[part.file] = `// ${part.about}\n\n${uses}${uses ? '\n' : ''}${body.replace(/\s+$/, '')}\n`;
  });
  const kept = inFile(-1);
  let preamble = -1;
  kept.forEach(({ item }, n) => { if (preamble === n - 1 && STAYS(item)) preamble = n; });
  const mods = plan.parts.map((_, f) => `${gate.get(f).map((cfg) => `${cfg}\n`).join('')}mod ${modOf[f]};\n`).join('');
  const piece = ({ item }) => (item.kind === 'use' ? pruned(item) : textOfItem(text, item));
  // The new `mod` lines join the ones the file has; without any, they open the block of new imports.
  const lastMod = kept.slice(0, preamble + 1).findLastIndex(({ item }) => item.kind === 'mod');
  const upToMods = header + kept.slice(0, lastMod + 1).map(piece).join('');
  const top = (lastMod < 0 ? upToMods : `${upToMods.replace(/\s+$/, '')}\n${mods}`) + kept.slice(lastMod + 1, preamble + 1).map(piece).join('');
  const block = `${lastMod < 0 ? `${mods}\n` : ''}${writeUses(imports.get(-1))}${extra(-1)}`;
  const rest = kept.slice(preamble + 1).map(piece).join('') + trailer;
  out[origin] = `${top.replace(/\s+$/, '')}${top.trim() ? '\n\n' : ''}${block}\n${rest.replace(/^(?:[ \t]*\n)+/, '')}`.replace(/\s+$/, '\n');
  return { files: out, notes: [...new Set(notes)] };
}
