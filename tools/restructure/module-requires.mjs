// Writes the `require` lines of a new module: the same modules the code used in
// its old file, spelled the way new code must spell them (full relative path with
// `.js`, `node:` for built-ins).

import { existsSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

const WIDTH = 100;
const toPosix = (file) => file.split(path.sep).join('/');

/**
 * @param {string} root the repo root
 * @returns {(spec: string, from: string, to: string) => { spec: string, kind: 'builtin' | 'package' | 'file', file: string | null }}
 *   `from` and `to` are repo-relative files: where the require is today and where it will be.
 */
export function createSpecRewriter(root) {
  const isFile = (file) => existsSync(file) && statSync(file).isFile();
  return (spec, from, to) => {
    if (isBuiltin(spec)) return { spec: spec.startsWith('node:') ? spec : `node:${spec}`, kind: 'builtin', file: null };
    if (!spec.startsWith('.')) return { spec, kind: 'package', file: null };
    const base = path.resolve(root, path.dirname(from), spec);
    const found = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')].find(isFile);
    if (!found) throw new Error(`require('${spec}') in ${from} points at no file`);
    let relative = toPosix(path.relative(path.resolve(root, path.dirname(to)), found));
    if (!relative.startsWith('.')) relative = `./${relative}`;
    return { spec: relative, kind: 'file', file: toPosix(path.relative(root, found)) };
  };
}

/**
 * Names on as few lines as fit the width, for `{ a, b, c }` lists.
 * @param {string[]} names @param {string} open text before the list @param {string} close text after it
 * @returns {string[]} lines
 */
export function wrapNames(names, open, close) {
  const oneLine = `${open} ${names.join(', ')} ${close}`;
  if (oneLine.length <= WIDTH) return [oneLine];
  const lines = [open];
  let row = ' ';
  for (const name of names) {
    if (row.length + name.length + 2 > WIDTH) { lines.push(row); row = ' '; }
    row += ` ${name},`;
  }
  lines.push(row, close);
  return lines;
}

/**
 * The `require` statements that give a new module the required names it uses.
 * @param {string[]} needed local names bound by a `require` in the old file
 * @param {Map<string, any>} bindings from analyze.mjs
 * @param {(spec: string) => {spec: string, kind: string, file: string | null}} rewrite
 * @returns {{ lines: string[], modules: {spec: string, kind: string, file: string | null, index: number}[] }}
 *   `index` is the position of the original require statement in the old file.
 */
export function requireLines(needed, bindings, rewrite) {
  const wanted = new Set(needed);
  const records = [...new Set(needed.map((name) => bindings.get(name).record))].sort((a, b) => a.index - b.index);
  const lines = [];
  const modules = [];
  for (const record of records) {
    const { spec, property, bindings: bound } = record.require;
    const module = rewrite(spec);
    const call = `require('${module.spec}')${property ? `.${property}` : ''};`;
    modules.push({ ...module, index: record.index });
    if (bound[0].text === '') lines.push(`const ${bound[0].local} = ${call}`);
    else lines.push(...wrapNames(bound.filter((b) => wanted.has(b.local)).map((b) => b.text), 'const {', `} = ${call}`));
  }
  return { lines, modules };
}
