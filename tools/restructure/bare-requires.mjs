// Says, for every `require('x');` that stands alone on a line, whether taking the line out can
// change anything. Such a line gives its file no name: all it does is load x, if nothing loaded x
// before. It is dead when one of three things is proven, and stays otherwise:
//
//   1. an earlier top-level line of the same file already loads the same file;
//   2. an earlier top-level line of the same file loads a file that always loads x first, and none
//      of the files on the way can lead back to this one (in a circle the other file may still be
//      half loaded when this line runs);
//   3. x and every file x loads run nothing when they load, and nobody asks for one of them from
//      inside a function or a condition (there this line may be what reads the file from disk at
//      start instead of in the middle of a call).
//
// "Runs nothing when it loads" is strict. Every top-level statement of the file has to be one of:
// 'use strict'; a function; a class or a variable whose value passes load-time-calls.mjs;
// `const x = require('y')` in one of its three shapes; a bare `require('y');`; `module.exports = value`,
// `module.exports.name = value` or `exports.name = value` with a value that passes the same rule.
// Anything else (a call, an if, a try, a loop, any other assignment) counts as running code.
// Pure: text in, verdicts out.

import { isBuiltin } from 'node:module';
import path from 'node:path';

import { createLoadTimeCheck, repoLoadTimeCalls } from './load-time-calls.mjs';
import { topStatements } from './state-refs.mjs';
import { lineAt, lineStarts, readTopLevel } from './top-level.mjs';

// The modules of Node whose loading does nothing a program can see.
export const INERT = new Set(['assert', 'buffer', 'child_process', 'crypto', 'dgram', 'dns', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'net',
  'os', 'path', 'perf_hooks', 'querystring', 'readline', 'stream', 'stream/promises', 'string_decoder', 'timers', 'timers/promises', 'tls', 'url',
  'util', 'zlib']);
const READ_AS_CODE = /\.c?js$/;
const SHOWN = 60;
const NOTHING = { runs: [], requires: [], unseen: [] };

/**
 * What one CommonJS file does when it loads, and every place it names `require`.
 * @param {string} text @param {any} parser from parser.mjs @param {string} [file]
 * @returns {{ runs: { line: number, text: string }[], requires: { spec: string, line: number, sure: boolean, bare: boolean }[], unseen: number[] }}
 *   `runs`: the top-level statements that run code, empty when the file only declares. `requires`: every `require('literal')`
 *   in file order; `sure` when it is a top-level statement of its own that runs whenever the file loads, `bare` when the
 *   statement is the call and nothing else. `unseen`: lines where `require` is used in a way this does not follow
 *   (a worked-out name, handed on as a value, a property called require). `typeof require` only asks whether there is one.
 */
export function loadFacts(text, parser, file = 'file.js') {
  const { K, NodeFlags } = parser;
  const sourceFile = parser.parse(text, file);
  const starts = lineStarts(text);
  const lineOf = (node) => lineAt(starts, node.getStart(sourceFile)) + 1;
  const shown = (node) => {
    const first = node.getText().split('\n')[0];
    return first.length > SHOWN ? `${first.slice(0, SHOWN)}...` : first;
  };
  const blocker = createLoadTimeCheck(K, repoLoadTimeCalls(), new Map());
  const isRequire = (node) => node.kind === K.CallExpression && node.expression.kind === K.Identifier && node.expression.text === 'require';
  const specOf = (call) => (call.arguments.length === 1 && call.arguments[0].kind === K.StringLiteral ? call.arguments[0].text : null);
  const dotted = (node) => (node.kind === K.Identifier ? node.text
    : node.kind === K.PropertyAccessExpression ? `${dotted(node.expression)}.${node.name.text}` : '?');
  const exported = (left) => /^(?:module\.exports(?:\.[^.?]+)?|exports\.[^.?]+)$/.test(dotted(left));
  const sure = new Set();

  const classRuns = (node, record) => record.loadCalls[0]
    || (node.heritageClauses ?? []).flatMap((clause) => [...clause.types]).map((type) => blocker(type.expression)).find(Boolean)
    || node.members.map((member) => (member.name?.kind === K.ComputedPropertyName ? blocker(member.name.expression) : '')).find(Boolean) || '';
  const expressionRuns = (expression) => {
    if (expression.kind === K.StringLiteral) return '';
    if (isRequire(expression) && specOf(expression) !== null) { sure.add(expression); return ''; }
    const gives = expression.kind === K.BinaryExpression && expression.operatorToken.kind === K.EqualsToken && exported(expression.left);
    return gives ? blocker(expression.right) : shown(expression);
  };
  const records = readTopLevel(sourceFile, parser);
  const runs = [];
  topStatements(sourceFile, parser).forEach((node, index) => {
    const record = records[index];
    let why = '';
    if (node.kind === K.ClassDeclaration) why = classRuns(node, record);
    else if (node.kind === K.VariableStatement && record.kind === 'require') {
      const first = node.declarationList.declarations[0].initializer;
      sure.add(first.kind === K.PropertyAccessExpression ? first.expression : first);
    } else if (node.kind === K.VariableStatement) why = record.loadCalls[0] ?? '';
    else if (node.kind === K.ExpressionStatement) why = expressionRuns(node.expression);
    else if (node.kind !== K.FunctionDeclaration && node.kind !== K.EmptyStatement) why = shown(node);
    if (why) runs.push({ line: lineOf(node), text: why });
  });

  const requires = [];
  const unseen = [];
  const bare = new Set();
  const isCode = (node) => (node.flags & NodeFlags.Reparsed) === 0
    && !(node.kind >= K.FirstTypeNode && node.kind <= K.LastTypeNode) && !(node.kind >= K.FirstJSDocNode && node.kind <= K.LastJSDocNode);
  const walk = (node, parent) => {
    if (!isCode(node)) return;
    if (node.kind === K.ExpressionStatement && isRequire(node.expression) && specOf(node.expression) !== null) bare.add(node.expression);
    if (node.kind === K.Identifier && node.text === 'require') {
      const call = parent && isRequire(parent) && parent.expression === node ? parent : null;
      const asked = parent && parent.kind === K.PropertyAccessExpression && parent.expression === node ? parent.name.text : '';
      if (call && specOf(call) !== null) requires.push({ spec: specOf(call), line: lineOf(call), sure: sure.has(call), bare: bare.has(call) });
      else if (asked !== 'main' && asked !== 'resolve' && parent?.kind !== K.TypeOfExpression) unseen.push(lineOf(node));
    }
    node.forEachChild((child) => walk(child, node));
  };
  walk(sourceFile, null);
  return { runs, requires, unseen };
}

function factsOfText(file, text, parser) {
  if (text === null) return null;
  if (file.endsWith('.json')) {
    try { JSON.parse(text); return NOTHING; } catch { return { ...NOTHING, broken: 'is not JSON that can be read: loading it fails' }; }
  }
  if (!READ_AS_CODE.test(file)) return { ...NOTHING, broken: 'is not a .js or .json file: what loading it does is not read' };
  return loadFacts(text, parser, file);
}

/**
 * @param {object} job
 * @param {string[]} job.files repo-relative files whose bare lines are judged; also where a require inside a function is looked for
 * @param {(file: string) => string | null} job.read the text of a file, null when there is no such file (a folder is no file)
 * @param {any} job.parser from parser.mjs
 * @param {(file: string) => string} [job.real] the one name of a file that can be reached under two (a linked folder)
 * @returns {{ rows: { file: string, line: number, spec: string, verdict: 'dead' | 'stays', why: string }[], unseen: { file: string, line: number }[] }}
 *   `unseen`: uses of `require` that were not followed; while there is one, rules 2 and 3 prove nothing for the files it could reach
 */
export function judgeBareRequires({ files, read, parser, real = (file) => file }) {
  const facts = new Map();
  const factsOf = (file) => {
    if (!facts.has(file)) facts.set(file, factsOfText(file, read(file), parser));
    return facts.get(file);
  };
  const resolve = (spec, from) => {
    if (isBuiltin(spec)) return { builtin: spec.replace(/^node:/, '') };
    if (!spec.startsWith('.')) return { package: spec };
    const base = path.posix.join(path.posix.dirname(from), spec);
    const found = [base, `${base}.js`, `${base}.json`, `${base}/index.js`].find((candidate) => read(candidate) !== null);
    return found ? { file: real(found) } : { missing: base };
  };
  const links = new Map();
  const linksOf = (file) => {
    if (!links.has(file)) links.set(file, (factsOf(file)?.requires ?? []).map((row) => ({ ...row, to: resolve(row.spec, file) })));
    return links.get(file);
  };
  // Every file reached from `from` over the links `follow` lets through; `stop` ends the walk with true.
  const reach = (from, follow, stop = () => false) => {
    const seen = new Set();
    const queue = [...from];
    while (queue.length) {
      const file = queue.pop();
      for (const link of linksOf(file)) {
        if (!link.to.file || !follow(link) || seen.has(link.to.file)) continue;
        if (stop(link.to.file)) return { seen, stopped: true };
        seen.add(link.to.file);
        queue.push(link.to.file);
      }
    }
    return { seen, stopped: false };
  };
  const closures = new Map();
  const alwaysLoads = (file) => {
    if (!closures.has(file)) closures.set(file, reach([file], (link) => link.sure).seen);
    return closures.get(file);
  };
  // A file that never says require has no line to judge and asks for nothing: it is not parsed for this.
  const scanned = files.map((file) => real(file)).filter((file) => (read(file) ?? '').includes('require'));
  // Where a file is asked for from inside a function or a condition: the first such place for each file.
  let lazy = null;
  const askedLater = (file) => {
    if (!lazy) {
      lazy = new Map();
      for (const from of scanned) {
        for (const link of linksOf(from)) if (link.to.file && !link.sure && !lazy.has(link.to.file)) lazy.set(link.to.file, `${from}:${link.line}`);
      }
    }
    return lazy.get(file);
  };

  // Rule 3: why `target` and what it loads cannot be said to run nothing, '' when they can.
  const notQuiet = (target) => {
    for (const file of [target, ...alwaysLoads(target)]) {
      const own = factsOf(file);
      if (own.broken) return `${file} ${own.broken}`;
      if (own.runs.length) return `${file} runs code when it loads (line ${own.runs[0].line}: ${own.runs[0].text})`;
      if (own.unseen.length) return `${file} uses require in a way that is not followed (line ${own.unseen[0]})`;
      for (const link of linksOf(file)) {
        if (!link.sure) continue;
        if (link.to.package) return `${file} loads the package ${link.to.package}, which is not read`;
        if (link.to.missing) return `${file} asks for ${link.spec}, which is no file here`;
        if (link.to.builtin && !INERT.has(link.to.builtin)) return `${file} loads ${link.to.builtin}, a module of Node that is not on the list of those that do nothing when loaded`;
      }
      const later = askedLater(file);
      if (later) return `${later} asks for ${file} from inside a function or a condition: without this line the file could be read from disk there`;
    }
    return '';
  };
  // Rule 2: the earlier line whose file always loads `target` first, when no file on the way can lead back to `file`.
  const loadedThrough = (file, earlier, target) => {
    for (const link of earlier) {
      if (!link.to.file || !alwaysLoads(link.to.file).has(target)) continue;
      const way = [link.to.file, ...alwaysLoads(link.to.file)].filter((step) => step !== target && alwaysLoads(step).has(target));
      const back = reach(way, () => true, (step) => step === file || factsOf(step).unseen.length > 0);
      if (!back.stopped && way.every((step) => factsOf(step).unseen.length === 0)) return link;
    }
    return null;
  };

  const judge = (file, at) => {
    const own = linksOf(file);
    const { to, sure } = own[at];
    if (!sure) return ['stays', 'it is inside a function or a block: when it runs is not read'];
    if (to.builtin) {
      return INERT.has(to.builtin) ? ['dead', `${to.builtin} is a module of Node that does nothing when loaded`]
        : ['stays', `${to.builtin} is a module of Node that is not on the list of those that do nothing when loaded`];
    }
    if (to.package) return ['stays', `${to.package} is a package: what it runs when it loads is not read`];
    if (to.missing) return ['stays', 'it names no file here: the line fails when it runs, and taking it out would hide that'];
    const earlier = own.slice(0, at).filter((link) => link.sure);
    const same = earlier.find((link) => link.to.file === to.file);
    if (same) return ['dead', `line ${same.line} of the same file already loads ${to.file}`];
    const through = loadedThrough(file, earlier, to.file);
    if (through) return ['dead', `line ${through.line} loads ${through.to.file}, which always loads ${to.file} first`];
    const why = notQuiet(to.file);
    return why ? ['stays', why] : ['dead', `${to.file} and all it loads only declare: nothing runs when they load`];
  };

  const rows = [];
  const unseen = [];
  for (const file of scanned) {
    for (const line of factsOf(file)?.unseen ?? []) unseen.push({ file, line });
    linksOf(file).forEach((link, at) => {
      if (!link.bare) return;
      const [verdict, why] = judge(file, at);
      rows.push({ file, line: link.line, spec: link.spec, verdict, why });
    });
  }
  return { rows, unseen };
}
