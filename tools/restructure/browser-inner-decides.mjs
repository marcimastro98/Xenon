// What keeps a function in its own script however little it uses of the wrapper: a
// decision about what the page may run, load or show as markup. A reviewer looks for
// those in the script they belong to, so `browser inner` leaves them there, and the
// survey counts with the same reading (browser-inner-judge.mjs asks it for every
// function and every constant).
//
// A function that only builds elements and writes text may leave, also when the text
// comes from outside. It stays when its code
//   - names a way to turn text into markup or into code: innerHTML, outerHTML,
//     insertAdjacentHTML, DOMParser, srcdoc, eval, `Function(`, document.write, and the
//     same thing under its other names (createContextualFragment, setHTMLUnsafe,
//     parseFromString), or the frame's `sandbox`;
//   - assigns `.href`, `.src`, `.action` (or srcset, formAction, poster, location), or
//     writes one of those as a key of an object with a value that is not written out,
//     or opens one that is not written out (`window.open`, `location.assign`, `location.replace`);
//   - calls setAttribute (toggleAttribute, setAttributeNS) with a name that is not a safe
//     one written out: class, id, role, title, type, for, tabindex, hidden, disabled,
//     draggable, aria-*, data-*;
//   - sets a style from a value that is not written out, or hands a style object on;
//   - creates a script, style, iframe, frame, object, embed, link, base or meta element.
// No flag turns a reason off.
//
// A helper that creates an element whose tag it is handed (`el(tag, cls, text)`) decides
// nothing itself: its callers do. So it must be proven: every use of every argument is
// the tag, a test, text (`textContent`, `createTextNode`, `append`), a class, a safe
// property or a safe attribute. And every call to a proven helper from code that moves
// must write the tag out, and not one of the tags above.

const HTML_WORDS = new Set(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'DOMParser', 'srcdoc', 'eval', 'createContextualFragment', 'setHTMLUnsafe', 'parseFromString', 'sandbox']);
const ADDRESS_PROPS = new Set(['href', 'src', 'action', 'srcset', 'formAction', 'poster', 'location']);
const ADDRESS_KEYS = new Set(['href', 'src', 'action', 'srcset', 'formAction', 'poster', 'style']);
/** The attributes a moved function may set by name. */
export const SAFE_ATTRIBUTES = new Set(['class', 'id', 'role', 'title', 'type', 'for', 'tabindex', 'hidden', 'disabled', 'draggable']);
const SAFE_PREFIXED = /^(?:aria|data)-[a-z0-9-]+$/;
/** Elements that run, load or style something by being there. */
export const UNSAFE_TAGS = new Set(['script', 'style', 'iframe', 'frame', 'object', 'embed', 'link', 'base', 'meta']);
// What a helper may do with an argument besides testing it: none of these runs or loads anything.
const SAFE_PROPS = new Set(['textContent', 'innerText', 'className', 'id', 'title', 'type', 'value', 'placeholder', 'htmlFor', 'name', 'disabled', 'hidden', 'tabIndex', 'checked', 'role', 'draggable', 'ariaLabel', 'ariaHidden']);
const OPENERS = new Set(['window', 'globalThis', 'self', 'parent', 'top']);
const ADDS = new Set(['append', 'appendChild', 'prepend']);
const COMPARES = ['EqualsEqualsToken', 'EqualsEqualsEqualsToken', 'ExclamationEqualsToken', 'ExclamationEqualsEqualsToken', 'LessThanEqualsToken', 'GreaterThanEqualsToken'];
const SHOWN = 50;
const WHY = 'a decision about markup, an address, an attribute or a style stays in its script';

const safeAttribute = (name) => SAFE_ATTRIBUTES.has(name) || SAFE_PREFIXED.test(name);
const shown = (node) => { const text = node.getText().split('\n')[0]; return text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text; };

const kindsByEnum = new WeakMap();
function kindsFor(K) {
  if (!kindsByEnum.has(K)) {
    kindsByEnum.set(K, {
      assigns: new Set(Object.keys(K).filter((key) => /EqualsToken$/.test(key) && !COMPARES.includes(key)).map((key) => K[key])),
      compares: new Set(COMPARES.map((key) => K[key])),
      functions: new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.GetAccessor, K.SetAccessor, K.Constructor]),
      strings: new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral]),
      flows: new Set([K.BarBarToken, K.QuestionQuestionToken, K.PlusToken, K.AmpersandAmpersandToken]),
    });
  }
  return kindsByEnum.get(K);
}

function createReader(K) {
  const kinds = kindsFor(K);
  const propOf = (node) => (node.kind === K.PropertyAccessExpression ? node.name.text
    : node.kind === K.ElementAccessExpression && kinds.strings.has(node.argumentExpression.kind) ? node.argumentExpression.text : null);
  const isMember = (node) => node.kind === K.PropertyAccessExpression || node.kind === K.ElementAccessExpression;
  const writtenOut = (node) => {
    switch (node.kind) {
      case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: case K.NumericLiteral: case K.TrueKeyword: case K.FalseKeyword: case K.NullKeyword: return true;
      case K.ParenthesizedExpression: return writtenOut(node.expression);
      case K.PrefixUnaryExpression: return node.operand.kind === K.NumericLiteral;
      case K.ConditionalExpression: return writtenOut(node.whenTrue) && writtenOut(node.whenFalse);
      default: return false;
    }
  };
  // The tags an argument can be: the string written there, or either side of `a ? 'x' : 'y'`. Null when it is not written out.
  const tagsIn = (node) => {
    if (kinds.strings.has(node.kind)) return [node.text];
    if (node.kind === K.ParenthesizedExpression) return tagsIn(node.expression);
    if (node.kind !== K.ConditionalExpression) return null;
    const [yes, no] = [tagsIn(node.whenTrue), tagsIn(node.whenFalse)];
    return yes && no ? [...yes, ...no] : null;
  };
  const lastName = (node) => (node.kind === K.Identifier ? node.text : node.kind === K.PropertyAccessExpression ? node.name.text : '');
  const isAssign = (node) => node?.kind === K.BinaryExpression && kinds.assigns.has(node.operatorToken.kind);
  // Only asked about, never handed on: `if (x)`, `!x`, `typeof x`, `x === 'solid'`, `x ? a : b`.
  const isTest = (node) => {
    const up = node.parent;
    return up.kind === K.TypeOfExpression || (up.kind === K.PrefixUnaryExpression && up.operator === K.ExclamationToken) || (up.kind === K.IfStatement && up.expression === node)
      || (up.kind === K.ConditionalExpression && up.condition === node) || (up.kind === K.BinaryExpression && kinds.compares.has(up.operatorToken.kind));
  };
  return { kinds, propOf, isMember, writtenOut, tagsIn, lastName, isAssign, isTest };
}

// Where the value of one use of an argument ends up: a name for it, or null when that is not a place a helper may write to.
function sinkOf(K, reader, id) {
  const { kinds, propOf } = reader;
  let at = id;
  for (let up = at.parent; up; up = at.parent) {
    switch (up.kind) {
      case K.ParenthesizedExpression: at = up; continue;
      case K.TypeOfExpression: return 'test';
      case K.PrefixUnaryExpression: return up.operator === K.ExclamationToken ? 'test' : null;
      case K.IfStatement: return up.expression === at ? 'test' : null;
      case K.ConditionalExpression: if (up.condition === at) return 'test'; at = up; continue;
      case K.BinaryExpression: {
        const operator = up.operatorToken.kind;
        if (kinds.compares.has(operator) || (operator === K.AmpersandAmpersandToken && up.left === at)) return 'test';
        if (kinds.flows.has(operator)) { at = up; continue; }
        if (operator !== K.EqualsToken || up.right !== at) return null;
        const prop = propOf(up.left);
        if (prop && SAFE_PROPS.has(prop)) return prop;
        return up.left.kind === K.PropertyAccessExpression && propOf(up.left.expression) === 'dataset' ? 'data-*' : null;
      }
      case K.CallExpression: {
        const index = up.arguments.indexOf(at);
        if (index === -1) return null;
        if (up.expression.kind === K.Identifier && up.expression.text === 'String') { at = up; continue; }
        if (up.expression.kind !== K.PropertyAccessExpression) return null;
        const method = up.expression.name.text;
        if ((method === 'createElement' && index === 0) || (method === 'createElementNS' && index === 1)) return 'createElement';
        if (method === 'createTextNode' || ADDS.has(method)) return method;
        if (method === 'add' && propOf(up.expression.expression) === 'classList') return 'classList';
        if (method === 'addEventListener' && index === 1) return 'listener';
        const named = up.arguments[0];
        return method === 'setAttribute' && index === 1 && kinds.strings.has(named.kind) && safeAttribute(named.text) ? `attribute ${named.text}` : null;
      }
      // The argument is the element things are added to: `parent.appendChild(node)`.
      case K.PropertyAccessExpression:
        return up.expression === at && ADDS.has(up.name.text) && up.parent?.kind === K.CallExpression && up.parent.expression === up ? `parent of ${up.name.text}` : null;
      default: return null;
    }
  }
  return null;
}

/**
 * Proves a function that creates an element whose tag is one of its arguments.
 * @param {Record<string, number>} K @param {any} fn the function @param {any} tag the expression handed to createElement
 * @returns {{ tag: number, writes: Record<string, string[]>, problems: string[] }} `tag`: which argument is the tag; `writes`: per argument,
 *   where it goes (tests left out); `problems`: why calls to it are not known to be safe, empty when they are
 */
export function proveHelper(K, fn, tag) {
  const reader = createReader(K);
  const params = fn.parameters.map((param) => (param.name.kind === K.Identifier && !param.dotDotDotToken ? param.name.text : null));
  const problems = [];
  if (params.includes(null)) problems.push('it takes its arguments in a pattern or as a rest');
  if (tag.kind !== K.Identifier || !params.includes(tag.text)) problems.push(`the tag \`${shown(tag)}\` is neither written out nor one of its arguments`);
  const writes = new Map(params.filter(Boolean).map((name) => [name, new Set()]));
  const visit = (node) => {
    if (node.kind === K.Identifier && writes.has(node.text)) {
      const up = node.parent;
      const isLabel = (up.kind === K.PropertyAccessExpression || up.kind === K.PropertyAssignment) && up.name === node;
      const declares = [K.VariableDeclaration, K.Parameter, K.BindingElement, K.FunctionDeclaration, K.FunctionExpression].includes(up.kind) && up.name === node && up.parent !== fn && up !== fn;
      if (declares) problems.push(`it declares ${node.text} again inside`);
      else if (!isLabel && !(up.kind === K.Parameter && up.parent === fn)) {
        const sink = sinkOf(K, reader, node);
        if (sink) writes.get(node.text).add(sink);
        else problems.push(`it uses its argument ${node.text} for more than text, a class or a safe attribute: \`${shown(up)}\``);
      }
    }
    node.forEachChild(visit);
  };
  if (fn.body) visit(fn.body);
  return { tag: tag.kind === K.Identifier ? params.indexOf(tag.text) : -1, problems,
    writes: Object.fromEntries([...writes].map(([name, sinks]) => [name, [...sinks].filter((sink) => sink !== 'test').sort()])) };
}

/**
 * Reads one statement of a wrapper for the decisions it holds.
 * @param {Record<string, number>} K SyntaxKind @param {any} statement @param {(node: any) => number} lineOf the line a node starts on, as the caller counts
 * @returns {{ decides: { line: number, text: string }[], calls: { name: string, line: number, args: (string[] | null)[] }[],
 *   helpers: Map<string, ReturnType<typeof proveHelper>> }} `decides`: what keeps the statement in its script; `calls`: every call of a plain
 *   name, with the strings written out in each argument; `helpers`: per name the statement declares as a function that creates an
 *   element whose tag it is handed, the proof (a failed proof is in `decides` too)
 */
export function readDecisions(K, statement, lineOf) {
  const reader = createReader(K);
  const { kinds, propOf, isMember, writtenOut, tagsIn, lastName, isAssign, isTest } = reader;
  const decides = [];
  const calls = [];
  const helpers = new Map();
  const say = (node, text) => decides.push({ line: lineOf(node), text });
  // The functions the statement declares by name: `function el() {}`, `const el = () => {}`.
  const named = new Map();
  if (statement.kind === K.FunctionDeclaration && statement.name) named.set(statement, statement.name.text);
  for (const declaration of statement.kind === K.VariableStatement ? statement.declarationList.declarations : []) {
    let value = declaration.initializer;
    while (value?.kind === K.ParenthesizedExpression) value = value.expression;
    if (value && declaration.name.kind === K.Identifier && (value.kind === K.ArrowFunction || value.kind === K.FunctionExpression)) named.set(value, declaration.name.text);
  }
  const functionAround = (node) => { let at = node.parent; while (at && !kinds.functions.has(at.kind)) at = at.parent; return at ?? null; };

  const styleOf = (node) => {
    const up = node.parent;
    const member = isMember(up) && up.expression === node ? up : null;
    const written = member ?? node;
    const holder = written.parent;
    if (isAssign(holder) && holder.left === written) {
      if (holder.operatorToken.kind !== K.EqualsToken || !writtenOut(holder.right) || (member && propOf(member) === null)) say(node, `sets a style from a value that is not written out: \`${shown(holder)}\``);
    } else if (member && holder.kind === K.CallExpression && holder.expression === member) {
      if (propOf(member) === 'setProperty' && !holder.arguments.every(writtenOut)) say(node, `sets a style from a value that is not written out: \`${shown(holder)}\``);
    } else if (!member && !isTest(node)) say(node, `hands a style object on, and what is written to it there cannot be read: \`${shown(up)}\``);
  };

  const callOf = (node) => {
    const args = node.arguments;
    if (node.expression.kind === K.Identifier) calls.push({ name: node.expression.text, line: lineOf(node), args: args.map(tagsIn) });
    if (node.expression.kind !== K.PropertyAccessExpression) return;
    const method = node.expression.name.text;
    if (['setAttribute', 'toggleAttribute', 'setAttributeNS'].includes(method)) {
      const name = args[method === 'setAttributeNS' ? 1 : 0];
      if (!name || !kinds.strings.has(name.kind) || !safeAttribute(name.text)) say(node, `calls ${method} with ${name ? `\`${shown(name)}\`` : 'no name'}, which is not a safe attribute written out`);
    }
    const opens = (method === 'open' && OPENERS.has(lastName(node.expression.expression))) || ((method === 'assign' || method === 'replace') && lastName(node.expression.expression) === 'location');
    if (opens && !(args[0] && writtenOut(args[0]))) say(node, `opens an address that is not written out: \`${shown(node)}\``);
    if (method === 'setAttributeNode' || method === 'setAttributeNodeNS') say(node, `calls ${method}: the attribute it sets is not written there`);
    if (method !== 'createElement' && method !== 'createElementNS') return;
    const tag = args[method === 'createElementNS' ? 1 : 0];
    if (!tag) return;
    const tags = tagsIn(tag);
    for (const name of tags ?? []) if (UNSAFE_TAGS.has(name.toLowerCase())) say(node, `creates a <${name}> element`);
    if (tags) return;
    const name = named.get(functionAround(node));
    if (!name) { say(node, `creates an element whose tag is not written out (\`${shown(tag)}\`), in code that is not a helper declared by name`); return; }
    const proof = proveHelper(K, functionAround(node), tag);
    helpers.set(name, proof);
    if (proof.problems.length) say(node, `creates an element whose tag it is handed, and is not proven to write the rest as text: ${proof.problems[0]}`);
  };

  const visit = (node) => {
    if ((node.kind === K.Identifier || kinds.strings.has(node.kind)) && HTML_WORDS.has(node.text)) say(node, `names \`${node.text}\``);
    if ((node.kind === K.CallExpression || node.kind === K.NewExpression) && node.expression.kind === K.Identifier && node.expression.text === 'Function') say(node, 'makes code out of text with `Function(`');
    if (node.kind === K.PropertyAccessExpression && (node.name.text === 'write' || node.name.text === 'writeln') && /doc(?:ument)?$/i.test(lastName(node.expression))) say(node, `calls \`document.${node.name.text}\``);
    if (isAssign(node) && ADDRESS_PROPS.has(propOf(node.left) ?? '')) say(node, `assigns \`.${propOf(node.left)}\``);
    if (isMember(node) && propOf(node) === 'style') styleOf(node);
    if (node.kind === K.PropertyAssignment && ADDRESS_KEYS.has(node.name.text ?? '') && !writtenOut(node.initializer)) say(node, `writes \`${node.name.text}\` into an object with a value that is not written out`);
    if (node.kind === K.ShorthandPropertyAssignment && ADDRESS_KEYS.has(node.name.text)) say(node, `writes \`${node.name.text}\` into an object with a value that is not written out`);
    if (node.kind === K.CallExpression) callOf(node);
    node.forEachChild(visit);
  };
  visit(statement);
  return { decides, calls, helpers };
}

/**
 * The reasons a record's decisions give, and the calls it makes to a proven helper with a tag that is not a safe one written out.
 * @param {any} record with `decides` and `calls` @param {string} label @param {(line: number) => number} lineOf the line of the file
 * @param {(name: string) => { tag: number, problems: string[] } | null} helperOf the proof of the helper a name stands for, null for any other name
 * @returns {string[]}
 */
export function decisionReasons(record, label, lineOf, helperOf) {
  const reasons = (record.decides ?? []).map((found) => `${label} ${found.text} (line ${lineOf(found.line)}): ${WHY}`);
  for (const call of record.calls ?? []) {
    const helper = helperOf(call.name);
    if (!helper || helper.problems.length) continue;
    const tags = call.args[helper.tag] ?? null;
    if (!tags) reasons.push(`${label} calls ${call.name} with a tag that is not written out (line ${lineOf(call.line)}): ${WHY}`);
    for (const tag of tags ?? []) if (UNSAFE_TAGS.has(tag.toLowerCase())) reasons.push(`${label} creates a <${tag}> element through ${call.name} (line ${lineOf(call.line)}): ${WHY}`);
  }
  return reasons;
}
