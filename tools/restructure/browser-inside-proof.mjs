// The standing check of a script cut out of ONE FUNCTION of a browser script
// (browser-inside.mjs; `inside: '<function>'` in the list of moves). The new script is in
// the handed form: `window.<Name> = (wrapper) => { const { … } = wrapper; …moved lines…;
// return { … }; };`, and the function it left takes the names back on one line:
// `const { … } = window.<Name>({ … });`. Read from the two texts as they are today:
//
// - the moved lines use nothing of the function or of its wrapper but what they are
//   handed, write to none of it, and hold no `this`, `arguments`, `return` or `await` of
//   the function they left;
// - what is handed is a copy, so each handed name is one that never changes after the
//   taking line: a function declaration, a `const`, or a `let`, `var` or parameter that is
//   written nowhere; and it is declared above the taking line when it is the function's;
// - what comes back is a copy too: neither side writes to a name that is given back;
// - a name the function takes back is a `const` now, where a function declaration could be
//   used above its own lines: so nothing that runs before the taking line may use one.
//   What runs before it: the function's own lines above it, a function written in a call
//   (but for a listener, a timer or what follows a promise, which wait), and every named
//   function those reach.
//
// A listener set off on purpose above the taking line (`.click()`, `dispatchEvent`) is
// not seen here; the shape check walks the window in two engines and would stop on it.

import { readScopes, functionsNamed } from './browser-inside-scope.mjs';
import { MAX_LINES } from './browser-plan.mjs';

/** More than a wrapper part is handed (8): a function's lines lean on the function's own names as well as on the wrapper's. */
export const MAX_INSIDE_HANDS = 40;
// Calls that keep the function they are given for later.
const WAITS = new Set(['addEventListener', 'then', 'catch', 'finally', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask', 'requestIdleCallback']);

const flat = (text) => text.replace(/\s+/g, ' ').trim();

// `{ a, b }` written with plain names only, as a pattern or as an object: the names, or null.
function plainNames(node, K) {
  const names = [];
  let plain = node.kind === K.ObjectBindingPattern || node.kind === K.ObjectLiteralExpression;
  if (plain) node.forEachChild((child) => {
    const ok = (child.kind === K.BindingElement && !child.propertyName && !child.initializer && !child.dotDotDotToken && child.name.kind === K.Identifier) || child.kind === K.ShorthandPropertyAssignment;
    if (ok) names.push(child.name.text); else plain = false;
  });
  return plain ? names : null;
}

/**
 * Reads a script cut out of a function.
 * @param {string} text @param {string} file @param {string} name its name on window @param {any} parser
 * @returns {{ problems: string[], hands: string[], gives: string[], free: Set<string> }} `free`: the names its lines use and nobody in the script declares
 */
export function readInsideScript(text, file, name, parser) {
  const { K } = parser;
  const read = readScopes(text, file, parser);
  const none = { hands: [], gives: [], free: new Set() };
  const problems = [];
  if (!text.startsWith('//')) problems.push(`${file} must open with a comment saying what it does`);
  if (text.split('\n').length - 1 > MAX_LINES) problems.push(`${file} is ${text.split('\n').length - 1} lines: a script cut out of a function stays within ${MAX_LINES}`);
  const top = read.tree.statements.filter((child) => !(child.kind === K.ExpressionStatement && child.expression.kind === K.StringLiteral));
  const set = top.length === 1 && top[0].kind === K.ExpressionStatement ? top[0].expression : null;
  const arrow = set && set.kind === K.BinaryExpression && flat(set.left.getText(read.tree)) === `window.${name}` ? set.right : null;
  // Handed nothing, it takes nothing: `window.<name> = () => { … };`.
  const takesIn = arrow?.kind === K.ArrowFunction && arrow.parameters.length === 1 && arrow.parameters[0].name.text === 'wrapper';
  if (!arrow || arrow.kind !== K.ArrowFunction || !(takesIn || arrow.parameters.length === 0) || arrow.body.kind !== K.Block) {
    return { ...none, problems: [...problems, `${file} must be one \`window.${name} = (wrapper) => { … };\` and nothing else`] };
  }
  const body = arrow.body.statements;
  const first = takesIn && body[0]?.kind === K.VariableStatement && body[0].declarationList.declarations.length === 1 ? body[0].declarationList.declarations[0] : null;
  const hands = !takesIn ? [] : first && first.initializer?.kind === K.Identifier && first.initializer.text === 'wrapper' ? plainNames(first.name, K) : null;
  const last = body.at(-1);
  const gives = last?.kind === K.ReturnStatement && last.expression ? plainNames(last.expression, K) : null;
  if (!hands) problems.push(`${file} must begin by taking what it is handed: \`const { … } = wrapper;\`, plain names only`);
  if (!gives?.length) problems.push(`${file} must end by giving its names back: \`return { … };\`, plain names only`);
  if (!hands || !gives?.length) return { ...none, problems };
  if (hands.length > MAX_INSIDE_HANDS) problems.push(`${file} is handed ${hands.length} names: more than ${MAX_INSIDE_HANDS} is a part that did not come apart`);

  const where = (node) => `${file}:${read.lineOf(read.startOf(node))}`;
  // `this` and `arguments` belong to the nearest function that is not an arrow, a `return` or an `await` to the nearest function of
  // any kind: in the moved lines, with none between (`plain`, `level`), that was the function they left.
  const visit = (node, plain, level) => {
    if (plain && node.kind === K.ThisKeyword) problems.push(`${where(node)} uses \`this\` of the function it left`);
    if (plain && node.kind === K.Identifier && node.text === 'arguments') problems.push(`${where(node)} uses \`arguments\` of the function it left`);
    if (level && (node.kind === K.ReturnStatement || node.kind === K.AwaitExpression || node.kind === K.YieldExpression)) {
      problems.push(`${where(node)} holds a \`${flat(node.getText(read.tree)).split(/[\s;(]/)[0]}\` of the function it left`);
    }
    const here = read.isFunction(node);
    node.forEachChild((child) => { visit(child, plain && !(here && node.kind !== K.ArrowFunction), level && !here); });
  };
  for (const statement of body.slice(takesIn ? 1 : 0, -1)) visit(statement, true, true);

  const handed = new Set(hands);
  const given = new Set(gives.map((give) => read.resolve(give, arrow.body)));
  for (const use of read.uses) {
    if (use.write && given.has(use.binding)) problems.push(`${where(use.node)} writes to ${use.name}, which it gives back: the function would keep the value it took`);
    if (use.name === 'wrapper' && use.binding?.kind === 'param' && use.node !== first?.initializer) problems.push(`${where(use.node)} reads \`wrapper\` again: what is handed is taken once, on the first line`);
    if (use.write && use.binding && first && handed.has(use.name) && use.binding.pos === read.startOf(body[0])) problems.push(`${where(use.node)} writes to ${use.name}, which it was handed: it would change its own copy`);
  }
  return { problems, hands, gives, free: new Set(read.uses.filter((use) => !use.binding).map((use) => use.name)) };
}

// The line of `fn` that takes the names of `window.<name>` back: `const { … } = window.<name>({ … });`, right in the function.
function takingLine(read, fn, name, K) {
  for (const statement of fn.body.statements) {
    const declared = statement.kind === K.VariableStatement && statement.declarationList.declarations.length === 1 ? statement.declarationList.declarations[0] : null;
    const call = declared?.initializer?.kind === K.CallExpression ? declared.initializer : null;
    if (!call || flat(call.expression.getText(read.tree)) !== `window.${name}`) continue;
    const gives = plainNames(declared.name, K);
    const hands = call.arguments.length === 0 ? [] : call.arguments.length === 1 ? plainNames(call.arguments[0], K) : null;
    return { statement, gives, hands };
  }
  return null;
}

// Whether a place in `fn` may run before the taking line.
function runsBefore(read, fn, taking, K) {
  const limit = taking.end;
  const outermost = (node) => { let found = null; for (let at = node.parent; at && at !== fn; at = at.parent) if (read.isFunction(at)) found = at; return found; };
  const waits = (node) => {
    const call = node.parent;
    if (!call || call.kind !== K.CallExpression || !call.arguments.includes(node)) return false;
    const callee = call.expression;
    return WAITS.has(callee.kind === K.PropertyAccessExpression ? callee.name.text : callee.kind === K.Identifier ? callee.text : '');
  };
  // A function with a name runs when something that runs names it; one written in a call that keeps it waits; any other runs where it stands.
  const named = new Map();
  const early = new Set();
  const note = (node) => {
    if (node !== fn && read.isFunction(node) && outermost(node) === null) {
      const holder = node.parent;
      const binding = node.kind === K.FunctionDeclaration && node.name ? read.resolve(node.name.text, node.parent)
        : holder.kind === K.VariableDeclaration && holder.initializer === node && holder.name.kind === K.Identifier ? read.resolve(holder.name.text, holder) : null;
      // A named function may be called from above wherever it stands; one written where it is used runs there, so only above the line.
      if (binding) named.set(binding, node); else if (!waits(node) && read.startOf(node) < limit) early.add(node);
      return;
    }
    node.forEachChild(note);
  };
  fn.body.forEachChild(note);
  const before = (node) => { const owner = outermost(node); return owner === null ? read.startOf(node) < limit : early.has(owner); };
  for (let grew = true; grew;) {
    grew = false;
    for (const use of read.uses) {
      const target = use.binding && named.get(use.binding);
      if (!target || early.has(target) || !before(use.node) || waits(use.node)) continue;
      early.add(target);
      grew = true;
    }
  }
  return before;
}

/**
 * @param {{ source: string, text: string, parts: { file: string, text: string, inside?: string | null, name?: string }[], parser: any }} job
 *   every script made of `source`, in the order a page loads them; the ones with `inside` are read here
 * @returns {string[]}
 */
export function insideStateProblems({ source, text, parts, parser }) {
  const cut = parts.filter((part) => part.inside);
  if (!cut.length) return [];
  const { K } = parser;
  const read = readScopes(text, source, parser);
  const problems = [];
  for (const part of cut) {
    const made = readInsideScript(part.text, part.file, part.name, parser);
    problems.push(...made.problems);
    const fns = functionsNamed(read, parser, part.inside);
    if (fns.length !== 1) { problems.push(`${source} has ${fns.length} functions called ${part.inside}: ${part.file} was cut out of one`); continue; }
    const [fn] = fns;
    const taking = takingLine(read, fn, part.name, K);
    if (text.split(`window.${part.name}`).length !== 2 || !taking) { problems.push(`${source} must take ${part.file} once, on one line right in ${part.inside}: \`const { … } = window.${part.name}({ … });\``); continue; }
    if (made.problems.length) continue;
    const { statement } = taking;
    const at = `${source}:${read.lineOf(read.startOf(statement))}`;
    if (!taking.gives || taking.gives.join() !== made.gives.join()) problems.push(`${at} takes ${taking.gives?.join(', ') ?? 'something else'} from ${part.file}, which gives ${made.gives.join(', ')}, in that order`);
    if (!taking.hands || taking.hands.join() !== made.hands.join()) problems.push(`${at} hands ${taking.hands?.join(', ') ?? 'something else'} to ${part.file}, which takes ${made.hands.join(', ')}, in that order`);
    if (!taking.gives || !taking.hands) continue;

    const within = (binding) => binding.pos >= read.startOf(fn) && binding.end <= fn.end;
    const handed = new Set(made.hands);
    for (const hand of made.hands) {
      const binding = read.resolve(hand, statement);
      if (!binding) { problems.push(`${at} hands ${hand}, which is no name of ${part.inside} or of its wrapper`); continue; }
      const written = read.uses.find((use) => use.binding === binding && use.write);
      if (written) problems.push(`${part.file} is handed ${hand}, which ${source}:${read.lineOf(written.pos)} writes to: the script would keep the value it was handed`);
      if (binding.kind !== 'function' && binding.kind !== 'param' && within(binding) && binding.end > read.startOf(statement)) problems.push(`${at} hands ${hand} above the line that declares it (${source}:${read.lineOf(binding.pos)})`);
    }
    // A name of the function or its wrapper that the moved lines use without being handed it would mean the page's, or nothing.
    for (const name of made.free) {
      if (!handed.has(name) && read.resolve(name, statement)) problems.push(`${part.file} uses ${name} of ${source} and is not handed it`);
    }
    const before = runsBefore(read, fn, statement, K);
    const taken = new Set(taking.gives.map((name) => read.resolve(name, fn.body)).filter((binding) => binding && binding.pos === read.startOf(statement)));
    for (const use of read.uses) {
      if (taken.has(use.binding) && use.write) problems.push(`${source}:${read.lineOf(use.pos)} writes to ${use.name}, which it took from ${part.file}: the script would keep its own`);
      if (taken.has(use.binding) && before(use.node)) problems.push(`${source}:${read.lineOf(use.pos)} can reach ${use.name} before the line that takes it (${at})`);
    }
  }
  return problems;
}
