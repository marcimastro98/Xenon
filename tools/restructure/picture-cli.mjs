#!/usr/bin/env node
// What a big file of the engine is made of, in lines, and what keeps each big piece in it.
// Needs `npm run quality:install` once. Reading only.
//
//   node tools/restructure/picture-cli.mjs [<file>] [--over <lines>] [--json]
//
// Without a file it reads server/server.js. `--over` sets the size from which a function
// is listed with what keeps it (40). The numbers add up to the file's line count.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readMap } from '../map/map.mjs';
import { analyze } from './analyze.mjs';
import { KINDS } from './branches-kinds.mjs';
import { readBranches } from './branches-scope.mjs';
import { branchHandlers, protectedNames } from './ledger.mjs';
import { createSpecRewriter } from './module-requires.mjs';
import { openParser, REPO_ROOT } from './parser.mjs';
import { picture, renderPicture } from './picture.mjs';
import { featureWords, featuresOf } from './remainder.mjs';
import { ownersOf } from './target-rules.mjs';
import { lineAt, lineStarts } from './top-level.mjs';

/**
 * What the value of each top-level `const` is: a function, a call, or plain data.
 * @param {string} text @param {any} parser @returns {Map<number, string>} by the statement's place in the file
 */
export function constShapes(text, parser) {
  const { K, NodeFlags } = parser;
  const sourceFile = parser.parse(text, 'shapes.js');
  const shapes = new Map();
  const FUNCTIONS = new Set([K.ArrowFunction, K.FunctionExpression]);
  const CALLS = new Set([K.CallExpression, K.NewExpression, K.AwaitExpression]);
  sourceFile.statements.filter((statement) => (statement.flags & NodeFlags.Reparsed) === 0).forEach((statement, index) => {
    if (statement.kind !== K.VariableStatement || statement.declarationList.declarations.length !== 1) return;
    const value = statement.declarationList.declarations[0].initializer;
    if (value) shapes.set(index, FUNCTIONS.has(value.kind) ? 'function' : CALLS.has(value.kind) ? 'call' : 'data');
  });
  return shapes;
}

/**
 * The chains of branches of a file, in lines.
 * @param {string} text @param {any} parser @param {any} analysis @param {Set<string>} handlers names of the functions that hold a chain
 * @returns {{ handler: string, first: number, last: number, bodies: any[] }[]}
 */
export function chainsOf(text, parser, analysis, handlers) {
  const starts = lineStarts(text);
  return KINDS.filter((kind) => handlers.has(kind.handler)).map((kind) => {
    const { chain, sourceFile, branches } = readBranches({ text, parser, analysis, kind });
    return { handler: kind.handler, first: lineAt(starts, chain.chain.getStart(sourceFile)) + 1, last: lineAt(starts, chain.chain.end - 1) + 1,
      bodies: branches.map(({ key, test, line, lines, moved }) => ({ key, test, line, lines, moved })) };
  });
}

function featureMap(file, analysis, kept) {
  const rewrite = createSpecRewriter(REPO_ROOT);
  const owners = new Map();
  const ownerOfSpec = (spec) => {
    if (!owners.has(spec)) {
      let target = null;
      try { target = rewrite(spec, file, file).file; } catch { /* a module that is not there on this machine */ }
      owners.set(spec, target ? ownersOf([target]).get(target) : null);
    }
    return owners.get(spec);
  };
  const words = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tools/restructure/feature-words.json'), 'utf8')).words;
  return featuresOf(analysis, { ownerOfSpec, words: featureWords(readMap().features, words), kept });
}

async function main(argv) {
  const json = argv.includes('--json');
  const at = argv.indexOf('--over');
  const over = at === -1 ? 40 : Number(argv[at + 1]);
  const file = (argv.find((arg, index) => !arg.startsWith('--') && index !== at + 1) ?? 'server/server.js').split('\\').join('/');
  if (!Number.isInteger(over) || over < 1) { console.error('--over takes a number of lines'); return 2; }
  const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const parser = await openParser();
  try {
    const shapes = constShapes(text, parser);
    const analysis = analyze(text, parser, file);
    const kept = protectedNames(REPO_ROOT, file, analysis.records).names;
    const chains = chainsOf(text, parser, analysis, branchHandlers(REPO_ROOT, file));
    const seen = picture({ text, analysis, kept, featureOf: featureMap(file, analysis, kept), shapes, chains, over });
    console.log(json ? JSON.stringify(seen, null, 1) : renderPicture(seen, file));
    return 0;
  } finally {
    parser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
