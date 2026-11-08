// Top-level functions nothing calls, and exports no other file reads. By name
// only: a function counts as used when its name shows up anywhere else as a
// word (a call, a reference, a string, even a comment), so this is a short list
// to check by hand, never one to delete blindly. A name built at runtime
// (window[name]) is invisible to it, and so is a caller outside this repo.
import { isTestFile } from './files.mjs';

const SOURCE = /\.[cm]?js$/;
// Native shells call into the page by name (webview eval), so they are read too.
const REFERENCE = /\.(?:[cm]?js|html?|json|svg|rs|cs|swift)$/;
const SKIP = /(^|\/)(node_modules|vendor|third[-_]party)\/|\.min\.js$/;
const IDENT = /[A-Za-z_$][\w$]*/g;
const DECLARATIONS = [
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gmd,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gmd,
];

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

// The text between `{` at `open` and its matching `}` (strings and comments are rare
// enough in export lists to be ignored).
function braceBody(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

// { exported: Set, inStatements: Map(name -> times written inside export lists),
//   defined: [{ name, at }] for `export const|let|var|class|function NAME` }
export function exportsOf(text) {
  const exported = new Set();
  const defined = [];
  const inStatements = new Map();
  const statement = (body, names) => {
    for (const name of names) exported.add(name);
    for (const [id] of body.matchAll(IDENT)) bump(inStatements, id);
  };
  for (const m of text.matchAll(/^module\.exports\s*=\s*\{/gm)) {
    const body = braceBody(text, m.index + m[0].length - 1);
    const names = [];
    for (const entry of body.split(',')) {
      const key = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:[:(]|$)/.exec(entry);
      if (key) names.push(key[1]);
    }
    statement(body, names);
  }
  for (const m of text.matchAll(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=.*$/gm)) statement(m[0].replace(/^module\./, ''), [m[1]]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
    statement(m[1], names);
  }
  for (const m of text.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s*([A-Za-z_$][\w$]*)/gmd)) {
    exported.add(m[1]);
    defined.push({ name: m[1], at: m.indices[1][0] });
  }
  return { exported, inStatements, defined };
}

export function declarationsOf(text) {
  const found = [];
  for (const re of DECLARATIONS) {
    for (const m of text.matchAll(re)) found.push({ name: m[1], line: lineAt(text, m.index), at: m.indices[1][0] });
  }
  return found;
}

// { dead, onlyTests, unusedExports } over `texts` (Map rel -> content).
export function findDeadCode(texts, { dirs = [] } = {}) {
  const inScope = (rel) => SOURCE.test(rel) && !SKIP.test(rel) && !isTestFile(rel)
    && (!dirs.length || dirs.some((d) => rel.startsWith(`${d.replace(/\/+$/, '')}/`)));
  const sources = new Map();
  const wanted = new Set();
  for (const [rel, text] of texts) {
    if (!inScope(rel)) continue;
    const decls = declarationsOf(text);
    const ex = exportsOf(text);
    sources.set(rel, { decls, ...ex });
    for (const d of decls) wanted.add(d.name);
    for (const name of ex.exported) wanted.add(name);
  }
  // name -> Map(file -> occurrences), only for the names declared or exported above.
  const seen = new Map();
  for (const [rel, text] of texts) {
    if (!REFERENCE.test(rel) || SKIP.test(rel)) continue;
    for (const [id] of text.matchAll(IDENT)) {
      if (!wanted.has(id)) continue;
      if (!seen.has(id)) seen.set(id, new Map());
      bump(seen.get(id), rel);
    }
  }
  const usesElsewhere = (name, rel) => {
    let app = 0;
    let tests = 0;
    for (const [file, n] of seen.get(name) || []) {
      if (file === rel) continue;
      if (isTestFile(file)) tests += n; else app += n;
    }
    return { app, tests };
  };
  const out = { dead: [], onlyTests: [], unusedExports: [] };
  for (const [rel, { decls, exported, inStatements, defined }] of sources) {
    // Where a name is defined is not a use of it: one count per definition site.
    const sites = new Map();
    for (const d of [...decls, ...defined]) {
      if (!sites.has(d.name)) sites.set(d.name, new Set());
      sites.get(d.name).add(d.at);
    }
    const ownUses = (name) => (seen.get(name)?.get(rel) || 0) - (sites.get(name)?.size || 0) - (inStatements.get(name) || 0);
    const reported = new Set();
    for (const d of decls) {
      if (reported.has(d.name)) continue;
      const { app, tests } = usesElsewhere(d.name, rel);
      if (ownUses(d.name) > 0 || app > 0) continue;
      reported.add(d.name);
      (tests ? out.onlyTests : out.dead).push({ file: rel, name: d.name, line: d.line, tests });
    }
    for (const name of exported) {
      if (reported.has(name)) continue;
      const { app, tests } = usesElsewhere(name, rel);
      if (app || tests) continue;
      out.unusedExports.push({ file: rel, name, ownUses: Math.max(0, ownUses(name)) });
    }
  }
  return out;
}
