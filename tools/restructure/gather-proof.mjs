// Proves that a gather (gather-plan.mjs) changed nothing but the spelling of a factory's own
// variables. Three things, none of them taken from the planner but the places it says it wrote to:
//   1. undone as text, the new file is the old file byte for byte;
//   2. the object holds the first values that left their lines, as they were written, and nothing else;
//   3. every place the undo touched is, in the old file, a use of the factory's own variable, and every
//      such use was touched: read off the scopes by a walk written here, apart from the planner's reader
//      (scope-uses.mjs), so a mistake in one shows up as a difference between the two.

import { calledProblems } from './gather-called.mjs';
import { GATHER_KEPT_NOTE } from './gather-plan.mjs';
import { AFTER_SHORT } from './gather-undo.mjs';

const escaped = (text) => text.replace(/[$]/g, '\\$&');
const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

/**
 * The uses of names that mean a variable declared straight in a factory's body, found by walking the tree with the
 * names each scope on the way hides: parameters, locals, catch variables, loop variables, the names of functions
 * and classes. A property (`x.name`, `{ name: 1 }`), a label and a declaration are not uses.
 * @param {any} tree @param {{ K: any, NodeFlags: any }} parser @param {string} factory @param {Set<string>} names
 * @returns {{ uses: { name: string, start: number }[], declared: Map<string, { kind: string, start: number }[]> } | null}
 *   `declared`: what the body itself declares under each name, with where the name is written
 */
export function bodyUses(tree, { K, NodeFlags }, factory, names) {
  const fn = tree.statements.find((statement) => statement.kind === K.FunctionDeclaration && statement.name?.text === factory);
  if (!fn?.body) return null;
  const FUNCTION_LIKE = new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.GetAccessor, K.SetAccessor,
    K.Constructor, K.ClassStaticBlockDeclaration]);
  const NAMED_MEMBER = new Set([K.PropertyAccessExpression, K.PropertyAssignment, K.MethodDeclaration, K.GetAccessor, K.SetAccessor, K.PropertyDeclaration,
    K.VariableDeclaration, K.Parameter, K.FunctionDeclaration, K.FunctionExpression, K.ClassDeclaration, K.ClassExpression]);
  const LABELLED = new Set([K.LabeledStatement, K.BreakStatement, K.ContinueStatement]);
  const notCode = (node) => (node.flags & NodeFlags.Reparsed) !== 0 || (node.kind >= K.FirstTypeNode && node.kind <= K.LastTypeNode)
    || (node.kind >= K.FirstJSDocNode && node.kind <= K.LastJSDocNode);
  const blockScoped = (list) => (list.flags & NodeFlags.BlockScoped) !== 0;
  const bound = (name, out) => {
    if (!name) return out;
    if (name.kind === K.Identifier) out.push(name);
    else name.forEachChild((element) => { if (element.kind === K.BindingElement) bound(element.name, out); });
    return out;
  };
  // What a list of statements declares for the block they stand in: let, const, classes and functions.
  const lexical = (statements, out = []) => {
    for (const statement of statements ?? []) {
      if (statement.kind === K.VariableStatement && blockScoped(statement.declarationList)) for (const d of statement.declarationList.declarations) bound(d.name, out);
      else if ((statement.kind === K.FunctionDeclaration || statement.kind === K.ClassDeclaration) && statement.name) out.push(statement.name);
    }
    return out;
  };
  // Every `var` of a function, however deep, except inside the functions it contains.
  const vars = (node, out = []) => {
    if (!node || notCode(node) || FUNCTION_LIKE.has(node.kind)) return out;
    if (node.kind === K.VariableDeclarationList && !blockScoped(node)) for (const d of node.declarations) bound(d.name, out);
    node.forEachChild((child) => { vars(child, out); });
    return out;
  };
  const hiding = (hidden, identifiers) => {
    const more = identifiers.map((identifier) => identifier.text).filter((name) => names.has(name) && !hidden.has(name));
    return more.length ? new Set([...hidden, ...more]) : hidden;
  };
  const isUse = (node, parent) => {
    if (NAMED_MEMBER.has(parent.kind)) return parent.name !== node;
    if (parent.kind === K.BindingElement) return parent.name !== node && parent.propertyName !== node;
    if (LABELLED.has(parent.kind)) return parent.label !== node;
    return parent.kind !== K.MetaProperty;
  };

  const uses = [];
  const walk = (node, hidden, parent) => {
    if (!node || notCode(node)) return;
    if (node.kind === K.Identifier) {
      if (names.has(node.text) && !hidden.has(node.text) && isUse(node, parent)) uses.push({ name: node.text, start: node.end - node.text.length });
      return;
    }
    if (FUNCTION_LIKE.has(node.kind)) {
      // A first value of a parameter sees the parameters, not what the body declares.
      const own = [...(node.parameters ?? []).flatMap((parameter) => bound(parameter.name, [])), ...(node.kind === K.FunctionExpression && node.name ? [node.name] : [])];
      const inParameters = hiding(hidden, own);
      const inBody = hiding(inParameters, [...vars(node.body), ...lexical(node.body?.statements)]);
      node.forEachChild((child) => {
        if (child === node.name) { if (child.kind === K.ComputedPropertyName) walk(child, hidden, node); return; }
        walk(child, child === node.body ? inBody : inParameters, node);
      });
      return;
    }
    let inside = hidden;
    if (node.kind === K.Block) inside = hiding(hidden, lexical(node.statements));
    else if (node.kind === K.CaseBlock) inside = hiding(hidden, node.clauses.flatMap((clause) => lexical(clause.statements)));
    else if (node.kind === K.CatchClause) inside = hiding(hidden, bound(node.variableDeclaration?.name, []));
    else if (node.kind === K.ClassExpression && node.name) inside = hiding(hidden, [node.name]);
    else if ((node.kind === K.ForStatement || node.kind === K.ForInStatement || node.kind === K.ForOfStatement)
      && node.initializer?.kind === K.VariableDeclarationList && blockScoped(node.initializer)) {
      inside = hiding(hidden, node.initializer.declarations.flatMap((d) => bound(d.name, [])));
    }
    node.forEachChild((child) => { walk(child, inside, node); });
  };
  const body = fn.body.statements.filter((statement) => !notCode(statement));
  for (const statement of body) walk(statement, new Set(), fn.body);

  const declared = new Map();
  const declare = (identifier, kind) => {
    if (!names.has(identifier.text)) return;
    declared.set(identifier.text, [...(declared.get(identifier.text) ?? []), { kind, start: identifier.end - identifier.text.length }]);
  };
  for (const statement of body) {
    if (statement.kind === K.VariableStatement) {
      const kind = (statement.declarationList.flags & NodeFlags.Const) ? 'const' : blockScoped(statement.declarationList) ? 'let' : 'var';
      for (const d of statement.declarationList.declarations) for (const identifier of bound(d.name, [])) declare(identifier, kind);
    } else if ((statement.kind === K.FunctionDeclaration || statement.kind === K.ClassDeclaration) && statement.name) declare(statement.name, 'function');
  }
  for (const identifier of [...fn.parameters.flatMap((parameter) => bound(parameter.name, [])), ...vars(fn.body)]) declare(identifier, 'other');
  return { uses, declared };
}

// The new text with the old names back, and where each name landed in it: `declares` for a first value that was
// left on its line and reads `let name` again. `long`: which of the written-out `name: object.name`, counted from the top,
// were `name: name` before and not the short `{ name }`; a wrong count shows as a file that does not come back byte for byte.
function undoWithPlaces(text, { object, names, kept, long }) {
  const any = [...names].sort((a, b) => b.length - a.length).map(escaped).join('|');
  const pattern = new RegExp(`(?<![\\w$.])(${any}): ${escaped(object)}\\.\\1(?![\\w$])${AFTER_SHORT}|(?<![\\w$])${escaped(object)}\\.(${any})(?![\\w$])`, 'g');
  const places = [];
  let out = '';
  let last = 0;
  let written = 0;
  for (const match of text.matchAll(pattern)) {
    out += text.slice(last, match.index);
    const name = match[1] ?? match[2];
    last = match.index + match[0].length;
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
    const declares = !match[1] && kept.includes(name) && text.slice(lineStart, match.index) === '  ' && /^\s*=(?![=>])/.test(text.slice(last, last + 40));
    if (declares) out += 'let ';
    if (match[1] !== undefined && long.has(written++)) out += `${name}: `;
    places.push({ name, at: out.length, declares });
    out += name;
  }
  return { text: out + text.slice(last), places };
}

/**
 * @param {object} rewrite
 * @param {string} rewrite.before the file before @param {string} rewrite.after the file after
 * @param {ReturnType<typeof import('./gather-plan.mjs').planGather>} rewrite.plan
 * @param {any} rewrite.parser @param {string} [rewrite.source]
 * @returns {string[]} problems, empty when the rewrite is proven
 */
export function proveGather({ before, after, plan, parser, source = 'file.js' }) {
  const problems = [];
  const { object, factory, names, kept, glue, removed } = plan;

  // 1. Undone, the file is the old file byte for byte: the object goes, the names come back, the declarations return.
  const now = after.split('\n');
  if (now.slice(glue.at, glue.at + glue.lines.length).join('\n') !== glue.lines.join('\n')) return ['the object is not where the plan put it'];
  now.splice(glue.at, glue.lines.length);
  const back = undoWithPlaces(now.join('\n'), { object, names, kept, long: new Set(plan.long ?? []) });
  const undone = back.text.split('\n');
  const blocks = [...removed].sort((a, b) => a.line - b.line);
  for (const block of blocks) undone.splice(block.line - 1, 0, ...block.lines);
  if (undone.join('\n') !== before) return ['undoing the rewrite does not give the old file back byte for byte'];

  // 2. The object holds every first value that left, as it was written, with its comments, and nothing else.
  const expected = [];
  for (const name of names) {
    const block = removed.find((entry) => entry.name === name);
    if (!block) {
      if (!kept.includes(name)) problems.push(`${name}: its declaration neither left nor stayed`);
      expected.push(`    ${name}: undefined, // ${GATHER_KEPT_NOTE}`);
      continue;
    }
    const code = block.lines.findIndex((line) => line.startsWith('  let '));
    const written = block.value === null ? `  let ${name};${block.trail}` : `  let ${name}${block.eq}${block.value};${block.trail}`;
    if (block.lines[code] !== written) problems.push(`${name}: the declaration that left is not the one the plan describes`);
    if (block.lines.slice(code + 1).some((line) => line.trim() !== '')) problems.push(`${name}: code after the declaration left with it`);
    if (block.lines.slice(0, code).some((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))) problems.push(`${name}: something other than its comment left with it`);
    expected.push(...block.lines.slice(0, code).map((line) => `  ${line}`), `    ${name}: ${block.value ?? 'undefined'},${block.trail}`);
  }
  const frame = glue.lines.at(-1) === '' ? glue.lines.slice(0, -1) : glue.lines;
  if (frame.join('\n') !== [`  const ${object} = {`, ...expected, '  };'].join('\n')) problems.push('the object does not hold exactly the first values that left their lines');

  // 3. Where the undo put a name back, the old file uses the factory's own variable; and nowhere else does it.
  const starts = [0];
  for (const line of back.text.split('\n')) starts.push(starts.at(-1) + line.length + 1);
  const oldStarts = [0];
  for (const line of before.split('\n')) oldStarts.push(oldStarts.at(-1) + line.length + 1);
  const touched = new Map();
  for (const place of back.places) {
    let line = starts.findLastIndex((start) => start <= place.at);
    const column = place.at - starts[line];
    for (const block of blocks) if (block.line - 1 <= line) line += block.lines.length;
    touched.set(oldStarts[line] + column, place);
  }
  const old = bodyUses(parser.parse(before, source), parser, factory, new Set(names));
  if (!old) return [...problems, `${factory} cannot be read back from the old file`];
  const wanted = new Map(old.uses.map((use) => [use.start, { name: use.name, declares: false }]));
  for (const name of names) {
    const own = old.declared.get(name) ?? [];
    if (own.length !== 1 || own[0].kind !== 'let') problems.push(`${name} was not one let of ${factory}'s body`);
    else if (kept.includes(name)) wanted.set(own[0].start, { name, declares: true });
  }
  for (const [at, use] of wanted) {
    const place = touched.get(at);
    if (!place) problems.push(`${use.name} at line ${lineOf(before, at)} of ${source} is ${factory}'s own and was not rewritten`);
    else if (place.name !== use.name || place.declares !== use.declares) problems.push(`${use.name} at line ${lineOf(before, at)} of ${source} was rewritten as something else`);
  }
  for (const [at, place] of touched) {
    if (!wanted.has(at)) problems.push(`${place.name} at line ${lineOf(before, at)} of ${source} was rewritten and is not ${factory}'s own variable: another one has its name there`);
  }

  // 4. Read again from nothing: the object is declared once, as a constant of the body, and is used only as the
  //    holder of one of its properties, as often as names were rewritten; no old name is left.
  const fresh = bodyUses(parser.parse(after, source), parser, factory, new Set([object, ...names]));
  if (!fresh) return [...problems, `${factory} cannot be read back from the new file`];
  const holder = fresh.declared.get(object) ?? [];
  if (holder.length !== 1 || holder[0].kind !== 'const') problems.push(`${object} is not one constant of ${factory}'s body`);
  for (const name of names) {
    if (fresh.declared.has(name)) problems.push(`${name} is still declared in ${factory}`);
    if (fresh.uses.some((use) => use.name === name)) problems.push(`${name} is still used in ${factory}`);
  }
  const held = fresh.uses.filter((use) => use.name === object);
  for (const use of held) {
    const prop = /^\.([A-Za-z_$][\w$]*)/.exec(after.slice(use.start + object.length, use.start + object.length + 200))?.[1];
    if (!names.includes(prop)) problems.push(`${object} is used at line ${lineOf(after, use.start)} as something other than the holder of one of its properties`);
  }
  if (held.length !== back.places.length) problems.push(`${back.places.length} names were rewritten, ${object} is used ${held.length} times`);
  const words = (after.match(new RegExp(`(?<![\\w$])${escaped(object)}(?![\\w$])`, 'g')) ?? []).length;
  if (words !== held.length + 1) problems.push(`the word ${object} stands ${words} times in the new file, ${held.length + 1} expected: once declared, and once per use`);

  // 5. A property that is called can hold only functions that ignore `this`: asked of the new file by gather-called.mjs.
  problems.push(...calledProblems({ tree: parser.parse(after, source), parser, object, names, kept }));
  return problems;
}
