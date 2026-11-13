// Lists the names a piece of code takes from outside itself and what it does with
// each one: read it, assign it again, or change the object it holds.
//
// It follows JavaScript's scoping (function, block, catch, class, hoisted `var`
// and functions), so a local variable never counts as an outside name.

const CHANGING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill',
  'copyWithin', 'set', 'add', 'delete', 'clear']);
const CHANGING_STATICS = new Set(['Object.assign', 'Object.defineProperty', 'Object.defineProperties',
  'Object.setPrototypeOf']);

/**
 * @param {Record<string, number>} K SyntaxKind
 * @param {Record<string, number>} NodeFlags
 * @returns {(statement: any, handedTo?: Set<string>) => Map<string, {read: number, write: number, change: number, eager: boolean, called: boolean}>}
 *   `eager` is true when the name is touched while the statement itself runs,
 *   false when only code inside a function body touches it. `called` is true when
 *   the statement itself calls the name, or a method of it, or builds it with `new`.
 *   `handedTo` receives, for every function the statement writes in place and does not
 *   call itself, the name the call around it starts with ('' when there is none to name).
 */
export function createUseReader(K, NodeFlags) {
  const FUNCTIONS = new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration,
    K.GetAccessor, K.SetAccessor, K.Constructor]);
  const CLASSES = new Set([K.ClassDeclaration, K.ClassExpression]);
  const notCode = (node) => (node.flags & NodeFlags.Reparsed) !== 0
    || (node.kind >= K.FirstTypeNode && node.kind <= K.LastTypeNode)
    || (node.kind >= K.FirstJSDocNode && node.kind <= K.LastJSDocNode);
  const isAssignment = (kind) => kind >= K.FirstAssignment && kind <= K.LastAssignment;
  const blockScoped = (list) => (list.flags & NodeFlags.BlockScoped) !== 0;

  let uses;
  let handed = new Set();
  let receiver = '';
  const isLocal = (name, scope) => {
    for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
    return false;
  };
  const note = (name, scope, how, deferred) => {
    for (let s = scope; s; s = s.parent) if (s.names.has(name)) return;
    let entry = uses.get(name);
    if (!entry) {
      entry = { read: 0, write: 0, change: 0, eager: false, called: false };
      uses.set(name, entry);
    }
    entry[how] += 1;
    if (!deferred) entry.eager = true;
  };

  // `f()`, `a.b.c()` and `new F()` run code of the name on the left while the statement runs.
  const noteCalled = (callee, scope, deferred) => {
    const root = deferred ? null : rootOf(callee);
    if (!root) return;
    for (let s = scope; s; s = s.parent) if (s.names.has(root.text)) return;
    const entry = uses.get(root.text);
    if (entry) entry.called = true;
  };

  const declare = (name, scope) => {
    if (!name) return;
    if (name.kind === K.Identifier) scope.names.add(name.text);
    else name.forEachChild((element) => { if (element.kind === K.BindingElement) declare(element.name, scope); });
  };
  const declareList = (list, scope) => { for (const d of list.declarations) declare(d.name, scope); };
  // `let`, `const`, classes and functions written directly in a statement list.
  const declareStatements = (statements, scope) => {
    for (const s of statements ?? []) {
      if (s.kind === K.VariableStatement && blockScoped(s.declarationList)) declareList(s.declarationList, scope);
      else if ((s.kind === K.FunctionDeclaration || s.kind === K.ClassDeclaration) && s.name) scope.names.add(s.name.text);
    }
  };
  // `var` anywhere in a function body belongs to the function.
  const hoistVars = (node, scope) => {
    if (!node || notCode(node) || FUNCTIONS.has(node.kind) || CLASSES.has(node.kind)) return;
    if (node.kind === K.VariableDeclarationList && !blockScoped(node)) declareList(node, scope);
    node.forEachChild((child) => { hoistVars(child, scope); });
  };
  const rootOf = (node) => {
    let at = node;
    while (at && (at.kind === K.PropertyAccessExpression || at.kind === K.ElementAccessExpression
      || at.kind === K.ParenthesizedExpression || at.kind === K.NonNullExpression)) at = at.expression;
    return at && at.kind === K.Identifier ? at : null;
  };
  // `require('./x').create(...)` starts with `require`, `a.b(c).d(...)` with `a`.
  const firstName = (callee, scope) => {
    let at = callee;
    while (at && at.kind !== K.Identifier && at.expression) at = at.expression;
    return at && at.kind === K.Identifier && !isLocal(at.text, scope) ? at.text : '';
  };
  // The arguments of a call that runs now go to whatever the call starts with.
  const visitArguments = (node, callee, scope, deferred, visitCallee) => {
    const outer = receiver;
    node.forEachChild((child) => {
      if (child === callee) return visitCallee(child);
      if (!deferred) receiver = firstName(callee, scope);
      visit(child, scope, deferred);
      receiver = outer;
    });
  };
  const changeRoot = (node, scope, deferred) => {
    const root = rootOf(node);
    if (root) note(root.text, scope, 'change', deferred);
  };
  const dotted = (node) => (node.kind === K.PropertyAccessExpression && node.expression.kind === K.Identifier
    ? `${node.expression.text}.${node.name.text}` : '');

  // The left side of an assignment, a `++`, or the variable of a `for...of`.
  const assignTo = (target, scope, deferred, alsoRead) => {
    if (!target) return;
    switch (target.kind) {
      case K.Identifier:
        note(target.text, scope, 'write', deferred);
        if (alsoRead) note(target.text, scope, 'read', deferred);
        return;
      case K.PropertyAccessExpression: case K.ElementAccessExpression:
        changeRoot(target.expression, scope, deferred);
        return visit(target, scope, deferred);
      case K.ParenthesizedExpression: case K.NonNullExpression: case K.SpreadElement: case K.SpreadAssignment:
        return assignTo(target.expression, scope, deferred, alsoRead);
      case K.ArrayLiteralExpression:
        for (const element of target.elements) assignTo(element, scope, deferred, false);
        return;
      case K.ObjectLiteralExpression:
        for (const property of target.properties) {
          if (property.kind === K.ShorthandPropertyAssignment) {
            note(property.name.text, scope, 'write', deferred);
            visit(property.objectAssignmentInitializer, scope, deferred);
          } else if (property.kind === K.PropertyAssignment) {
            if (property.name.kind === K.ComputedPropertyName) visit(property.name, scope, deferred);
            assignTo(property.initializer, scope, deferred, false);
          } else assignTo(property, scope, deferred, false);
        }
        return;
      case K.BinaryExpression:
        if (target.operatorToken.kind === K.EqualsToken) {
          assignTo(target.left, scope, deferred, false);
          return visit(target.right, scope, deferred);
        }
        return visit(target, scope, deferred);
      default: return visit(target, scope, deferred);
    }
  };

  const visitFunction = (node, scope, bodyDeferred = true) => {
    if (node.name && node.name.kind === K.ComputedPropertyName) visit(node.name, scope, false);
    const inner = { names: new Set(), parent: scope };
    if (node.kind === K.FunctionExpression && node.name) inner.names.add(node.name.text);
    if (node.kind !== K.ArrowFunction) inner.names.add('arguments');
    for (const parameter of node.parameters ?? []) declare(parameter.name, inner);
    if (node.body) hoistVars(node.body, inner);
    if (node.body && node.body.kind === K.Block) declareStatements(node.body.statements, inner);
    for (const parameter of node.parameters ?? []) visit(parameter, inner, bodyDeferred);
    if (!node.body) return;
    if (node.body.kind === K.Block) for (const s of node.body.statements) visit(s, inner, bodyDeferred);
    else visit(node.body, inner, bodyDeferred);
  };

  const visitClass = (node, scope, deferred) => {
    const inner = { names: new Set(), parent: scope };
    if (node.kind === K.ClassExpression && node.name) inner.names.add(node.name.text);
    for (const clause of node.heritageClauses ?? []) for (const type of clause.types) visit(type.expression, inner, deferred);
    for (const member of node.members ?? []) {
      if (FUNCTIONS.has(member.kind)) visitFunction(member, inner);
      else if (member.kind === K.PropertyDeclaration) {
        if (member.name.kind === K.ComputedPropertyName) visit(member.name, inner, deferred);
        const isStatic = (member.modifiers ?? []).some((m) => m.kind === K.StaticKeyword);
        visit(member.initializer, inner, isStatic ? deferred : true);
      } else if (member.kind === K.ClassStaticBlockDeclaration) visitBlock(member.body, inner, deferred);
    }
  };

  const visitBlock = (block, scope, deferred, names) => {
    const inner = { names: names ?? new Set(), parent: scope };
    declareStatements(block.statements, inner);
    for (const s of block.statements) visit(s, inner, deferred);
  };

  const visitLoop = (node, scope, deferred) => {
    const inner = { names: new Set(), parent: scope };
    const head = node.initializer;
    if (head && head.kind === K.VariableDeclarationList) {
      if (blockScoped(head)) declareList(head, inner);
      visit(head, inner, deferred);
    } else if (node.kind === K.ForStatement) visit(head, inner, deferred);
    else assignTo(head, inner, deferred, false);
    for (const part of [node.condition, node.incrementor, node.expression, node.statement]) visit(part, inner, deferred);
  };

  const visitCall = (node, scope, deferred) => {
    const callee = node.expression;
    if (callee.kind === K.PropertyAccessExpression && CHANGING_METHODS.has(callee.name.text)) {
      changeRoot(callee.expression, scope, deferred);
    }
    if (CHANGING_STATICS.has(dotted(callee)) && node.arguments[0]) changeRoot(node.arguments[0], scope, deferred);
    // `(() => { ... })()`: the function written in place runs with the call, not later.
    let inPlace = callee;
    while (inPlace.kind === K.ParenthesizedExpression) inPlace = inPlace.expression;
    const runsNow = inPlace.kind === K.FunctionExpression || inPlace.kind === K.ArrowFunction;
    visitArguments(node, callee, scope, deferred, () => {
      if (runsNow) visitFunction(inPlace, scope, deferred);
      else visit(callee, scope, deferred);
    });
    noteCalled(callee, scope, deferred);
  };

  function visit(node, scope, deferred) {
    if (!node || notCode(node)) return;
    if (FUNCTIONS.has(node.kind)) {
      if (!deferred) handed.add(receiver);
      return visitFunction(node, scope);
    }
    if (CLASSES.has(node.kind)) return visitClass(node, scope, deferred);
    switch (node.kind) {
      case K.Identifier: return note(node.text, scope, 'read', deferred);
      case K.PropertyAccessExpression: return visit(node.expression, scope, deferred);
      case K.MetaProperty: case K.BreakStatement: case K.ContinueStatement: return;
      case K.LabeledStatement: return visit(node.statement, scope, deferred);
      case K.PropertyAssignment:
        if (node.name.kind === K.ComputedPropertyName) visit(node.name, scope, deferred);
        return visit(node.initializer, scope, deferred);
      case K.ShorthandPropertyAssignment:
        note(node.name.text, scope, 'read', deferred);
        return visit(node.objectAssignmentInitializer, scope, deferred);
      case K.VariableDeclaration: case K.Parameter: case K.BindingElement:
        if (node.propertyName && node.propertyName.kind === K.ComputedPropertyName) visit(node.propertyName, scope, deferred);
        if (node.name && node.name.kind !== K.Identifier) visit(node.name, scope, deferred);
        return visit(node.initializer, scope, deferred);
      case K.Block: case K.CaseBlock: {
        if (node.kind === K.Block) return visitBlock(node, scope, deferred);
        const inner = { names: new Set(), parent: scope };
        for (const clause of node.clauses) declareStatements(clause.statements, inner);
        for (const clause of node.clauses) {
          visit(clause.expression, inner, deferred);
          for (const s of clause.statements) visit(s, inner, deferred);
        }
        return;
      }
      case K.CatchClause: {
        const names = new Set();
        if (node.variableDeclaration) declare(node.variableDeclaration.name, { names });
        return visitBlock(node.block, scope, deferred, names);
      }
      case K.ForStatement: case K.ForInStatement: case K.ForOfStatement: return visitLoop(node, scope, deferred);
      case K.BinaryExpression:
        if (!isAssignment(node.operatorToken.kind)) break;
        assignTo(node.left, scope, deferred, node.operatorToken.kind !== K.EqualsToken);
        return visit(node.right, scope, deferred);
      case K.PrefixUnaryExpression: case K.PostfixUnaryExpression:
        if (node.operator !== K.PlusPlusToken && node.operator !== K.MinusMinusToken) break;
        return assignTo(node.operand, scope, deferred, true);
      case K.DeleteExpression: changeRoot(node.expression, scope, deferred); break;
      case K.CallExpression: return visitCall(node, scope, deferred);
      case K.NewExpression:
        visitArguments(node, node.expression, scope, deferred, (callee) => visit(callee, scope, deferred));
        return noteCalled(node.expression, scope, deferred);
      case K.TaggedTemplateExpression:
        node.forEachChild((child) => { visit(child, scope, deferred); });
        return noteCalled(node.tag, scope, deferred);
      default:
    }
    node.forEachChild((child) => { visit(child, scope, deferred); });
  }

  return (statement, handedTo = new Set()) => {
    uses = new Map();
    handed = handedTo;
    receiver = '';
    // A top-level function's body runs only when called; everything else runs now.
    visit(statement, null, false);
    return uses;
  };
}
