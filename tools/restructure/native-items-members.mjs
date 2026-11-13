// How one C# or Swift item is read: where it ends and what it is called. The Rust
// reader and the walk over a whole file are in native-items.mjs.

import { cursor, matching } from './native-lex.mjs';

const CS_MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'readonly', 'sealed', 'abstract', 'virtual', 'override', 'async',
  'unsafe', 'extern', 'partial', 'new', 'volatile', 'required', 'file', 'ref',
]);
const CS_TYPES = new Set(['class', 'struct', 'interface', 'enum', 'record', 'delegate']);

/** Reads one C# member or top-level declaration that starts at token `s`. */
export function csItem(text, tokens, s, hi) {
  const c = cursor(text, tokens, hi);
  let k = s;
  while (c.str(k) === '[') k = c.next(matching(text, tokens, k) + 1);
  const modifiers = [];
  while (CS_MODIFIERS.has(c.word(k))) { modifiers.push(c.word(k)); k = c.next(k + 1); }
  const vis = modifiers.filter((m) => ['public', 'private', 'protected', 'internal'].includes(m)).join(' ');
  const first = c.word(k);
  if (first === 'using') return { last: c.semicolon(k), kind: 'using', name: text.slice(tokens[c.next(k + 1)].start, tokens[c.semicolon(k)].start).trim(), vis };
  if (first === 'namespace' || CS_TYPES.has(first)) {
    let nameAt = c.next(k + 1);
    if (first === 'record' && CS_TYPES.has(c.word(nameAt))) nameAt = c.next(nameAt + 1);
    const stop = c.find(k, (t) => t === ';' || t === '{');
    const kind = first === 'namespace' || first === 'enum' || first === 'delegate' ? first : 'type';
    const name = first === 'delegate' ? c.word(c.find(k, (t) => t === '(') - 1) : c.word(nameAt);
    return c.str(stop) === '{' ? { last: matching(text, tokens, stop), open: stop, kind, name, vis } : { last: stop, kind, name, vis };
  }
  const isArrow = (n) => c.str(n) === '=' && text[tokens[n].start + 1] === '>';
  let name = '';
  const stop = c.find(k, (t, n) => {
    if (t === '(' || t === '=' || t === '{' || t === ';') return true;
    if (tokens[n].kind === 'word') name = t;
    return false;
  });
  const sign = c.str(stop);
  if (sign === ';') return { last: stop, kind: 'field', name, vis };
  if (isArrow(stop)) return { last: c.semicolon(stop), kind: 'property', name, vis };
  if (sign === '=') return { last: c.semicolon(stop), kind: c.word(k) === 'const' ? 'const' : 'field', name, vis };
  if (sign === '{') {
    const close = matching(text, tokens, stop);
    const after = c.next(close + 1);
    return { last: c.str(after) === '=' && !isArrow(after) ? c.semicolon(after) : close, kind: 'property', name, vis };
  }
  const body = c.find(matching(text, tokens, stop) + 1, (t, n) => t === '{' || t === ';' || isArrow(n));
  if (c.str(body) === '{') return { last: matching(text, tokens, body), open: body, kind: 'method', name, vis };
  return { last: c.str(body) === ';' ? body : c.semicolon(body), kind: 'method', name, vis };
}

const SWIFT_DECLARES = new Set([
  'func', 'var', 'let', 'class', 'struct', 'enum', 'extension', 'protocol', 'typealias', 'init', 'deinit', 'case', 'import', 'subscript', 'actor',
]);
const SWIFT_MODIFIERS = new Set([
  'private', 'fileprivate', 'internal', 'public', 'open', 'static', 'final', 'override', 'mutating', 'nonmutating', 'lazy', 'weak',
  'unowned', 'indirect', 'convenience', 'required', 'dynamic', 'nonisolated',
]);

/**
 * Reads one Swift declaration that starts at token `s`. Swift has no semicolons: a
 * declaration ends at a line end outside every bracket, when what follows starts
 * another declaration or closes the body.
 */
export function swiftItem(text, tokens, s, hi) {
  const c = cursor(text, tokens, hi);
  let kind = '';
  let name = '';
  let vis = '';
  let open;
  for (let k = c.next(s); k < hi; k = c.next(k + 1)) {
    const w = c.word(k);
    if (!kind && (w === 'private' || w === 'fileprivate' || w === 'public' || w === 'internal')) vis = w;
    const follower = c.next(k + 1);
    if (!kind && SWIFT_DECLARES.has(w) && !(w === 'class' && ['func', 'var', 'let'].includes(c.word(follower)))) {
      kind = w;
      name = ['init', 'deinit', 'subscript'].includes(w) ? w : c.word(follower);
    }
    if (tokens[k].kind === 'punct' && '([{'.includes(c.str(k))) {
      if (kind && open === undefined && c.str(k) === '{') open = k;
      k = matching(text, tokens, k);
      if (k < 0) return { last: -1, kind, name, vis };
    }
    if (!kind) continue;
    const ahead = c.next(k + 1);
    if (ahead < hi && !text.slice(tokens[k].end, tokens[ahead].start).includes('\n')) continue;
    if (ahead >= hi || SWIFT_DECLARES.has(c.word(ahead)) || SWIFT_MODIFIERS.has(c.word(ahead)) || c.str(ahead) === '@' || c.str(ahead) === '}') {
      const bodied = ['class', 'struct', 'enum', 'extension', 'protocol', 'actor', 'func', 'init', 'deinit'].includes(kind);
      return { last: k, kind, name, vis, open: bodied ? open : undefined };
    }
  }
  return { last: -1, kind, name, vis };
}
