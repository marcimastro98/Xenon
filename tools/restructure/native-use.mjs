// Rust `use` lines: read one into the names it brings in, and write a list of names
// back as tidy lines. The splitter needs both to give a new file exactly the imports
// its items use.

/**
 * @typedef {object} Leaf one imported name
 * @property {string[]} path the segments before the name
 * @property {string} name the last segment, `*` for a glob, `self` for the module itself
 * @property {string} [alias] the name after `as`
 */

const squeeze = (s) => s.replace(/\s+/g, '');

/**
 * @param {string} tree what stands between `use` and `;`, e.g. `std::io::{self, Read as R}`
 * @returns {Leaf[]}
 */
export function useLeaves(tree) {
  const text = tree.replace(/\/\/[^\n]*/g, '').replace(/\s+as\s+/g, '@').replace(/\s+/g, '');
  /** @type {Leaf[]} */
  const leaves = [];
  const walk = (part, prefix) => {
    const brace = part.indexOf('{');
    if (brace < 0) {
      const [pathText, alias] = part.split('@');
      const segments = pathText.split('::').filter(Boolean);
      const name = segments.pop();
      if (name) leaves.push({ path: [...prefix, ...segments], name, ...(alias ? { alias } : {}) });
      return;
    }
    const head = part.slice(0, brace).split('::').filter(Boolean);
    let depth = 0;
    let from = brace + 1;
    for (let i = brace + 1; i < part.length; i += 1) {
      if (part[i] === '{') depth += 1;
      const closes = part[i] === '}' && depth === 0;
      if (part[i] === '}') depth -= 1;
      if ((part[i] === ',' && depth === 0) || closes) {
        if (i > from) walk(part.slice(from, i), [...prefix, ...head]);
        from = i + 1;
      }
    }
  };
  walk(text, []);
  return leaves;
}

/** @param {Leaf} leaf @returns {string} the name code uses for it */
export const boundName = (leaf) => leaf.alias ?? (leaf.name === 'self' ? leaf.path[leaf.path.length - 1] : leaf.name);

/**
 * @typedef {object} Import one name a file needs
 * @property {string[]} cfg #[cfg(...)] lines it stands under
 * @property {string} vis `pub(crate)` for a re-export, '' for a plain import
 * @property {Leaf} leaf
 */

const leafText = (leaf) => (leaf.alias ? `${leaf.name} as ${leaf.alias}` : leaf.name);
// std first, then other crates, then this crate: the order the rest of the code uses.
const rank = (path) => (['std', 'core', 'alloc'].includes(path[0]) ? 0 : ['crate', 'super', 'self'].includes(path[0]) ? 2 : 1);

/**
 * @param {Import[]} imports
 * @returns {string} `use` lines, one per path and cfg, names of the same path in one pair of braces
 */
export function writeUses(imports, compact = false) {
  if (compact) return writeCompact(imports);
  const groups = new Map();
  for (const item of imports) {
    const key = JSON.stringify([item.cfg, item.vis, item.leaf.path]);
    if (!groups.has(key)) groups.set(key, { ...item, names: new Set() });
    groups.get(key).names.add(leafText(item.leaf));
  }
  const rows = [...groups.values()].sort((a, b) => rank(a.leaf.path) - rank(b.leaf.path)
    || a.leaf.path.join('::').localeCompare(b.leaf.path.join('::')) || a.cfg.join().localeCompare(b.cfg.join()));
  return rows.map((row) => {
    const names = [...row.names].sort((a, b) => (a === 'self' ? -1 : b === 'self' ? 1 : a.localeCompare(b)));
    const path = row.leaf.path.join('::');
    const tail = names.length === 1 && names[0] !== 'self' ? names[0] : `{${names.join(', ')}}`;
    const line = `${row.vis ? `${row.vis} ` : ''}use ${path ? `${path}::` : ''}${tail};`;
    return `${row.cfg.map((cfg) => `${cfg}\n`).join('')}${line}\n`;
  }).join('');
}

/** One `use` per first segment, the rest nested in braces and wrapped: for a file with many imports and few lines to spare. */
function writeCompact(imports) {
  const plain = imports.filter((item) => item.cfg.length === 0 && !item.vis && item.leaf.path.length > 0);
  const roots = [...new Set(plain.map((item) => item.leaf.path[0]))].sort((a, b) => rank([a]) - rank([b]) || a.localeCompare(b));
  const nest = (list, depth) => {
    const here = list.filter((item) => item.leaf.path.length === depth).map((item) => leafText(item.leaf));
    const below = [...new Set(list.filter((item) => item.leaf.path.length > depth).map((item) => item.leaf.path[depth]))].sort();
    const parts = [...new Set(here)].sort().concat(below.map((segment) => `${segment}::${nest(list.filter((item) => item.leaf.path[depth] === segment && item.leaf.path.length > depth), depth + 1)}`));
    return parts.length === 1 ? parts[0] : `{${parts.join(', ')}}`;
  };
  // Wrapped between the entries of the outer braces only, so a module's names stay on one line.
  const lines = roots.map((root) => {
    const body = nest(plain.filter((item) => item.leaf.path[0] === root), 1);
    const flat = `use ${root}::${body};`;
    if (flat.length <= 100 || !body.startsWith('{')) return `${flat}\n`;
    const entries = [];
    let depth = 0;
    let from = 1;
    for (let i = 1; i < body.length - 1; i += 1) {
      if (body[i] === '{') depth += 1;
      if (body[i] === '}') depth -= 1;
      if (body[i] === ',' && depth === 0) { entries.push(body.slice(from, i).trim()); from = i + 1; }
    }
    entries.push(body.slice(from, -1).trim());
    const rows = [];
    // First row with room, not only the last: long entries would otherwise leave half-empty rows.
    for (const entry of entries) {
      const fits = rows.findIndex((row) => `    ${row}, ${entry},`.length <= 100);
      if (fits >= 0) rows[fits] = `${rows[fits]}, ${entry}`;
      else rows.push(entry);
    }
    return `use ${root}::{\n${rows.map((row) => `    ${row},\n`).join('')}};\n`;
  });
  return lines.join('') + writeUses(imports.filter((item) => !plain.includes(item)));
}

/**
 * The same path seen from a module one level below the one it was written in.
 * @param {string[]} path @param {Set<string>} localNames names the first segment may be, when the path starts in the old module
 * @param {string[]} up how the new module names the old one: ['super'] or ['crate']
 * @returns {string[]}
 */
export function deeperPath(path, localNames, up) {
  if (path.length === 0) return path;
  if (path[0] === 'self') return [...up, ...path.slice(1)];
  if (path[0] === 'super') return up[0] === 'crate' ? path : ['super', ...path];
  return localNames.has(path[0]) ? [...up, ...path] : path;
}

export { squeeze };
