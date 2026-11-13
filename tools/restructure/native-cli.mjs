#!/usr/bin/env node
// Splits the big Rust, C# and Swift files by moving whole items, and proves it.
//
//   node tools/restructure/native-cli.mjs outline <file> [--deep]   the items of a file, with lines
//   node tools/restructure/native-cli.mjs split <plan.json> [--write]   cut a file as a plan says
//   node tools/restructure/native-cli.mjs prove [--base <commit>]   same items, same text, before and after

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { langOf } from './native-lex.mjs';
import { bodyItems, fileItems } from './native-items.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {string} file repo-relative @returns {string} its text with \n line ends */
export function readSource(file, root = ROOT) {
  return fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
}

function outline(file, deep) {
  const text = readSource(file);
  const lang = langOf(file);
  const { tokens, items } = fileItems(text, lang);
  const row = (item, indent) => `${indent}${String(item.line).padStart(5)} ${String(item.lines).padStart(4)}  ${item.vis ? `${item.vis} ` : ''}${item.key}${item.cfg.length ? `   ${item.cfg.join(' ')}` : ''}`;
  for (const item of items) {
    if (item.kind === 'use' || item.kind === 'using') continue;
    console.log(row(item, ''));
    const nested = deep || (lang !== 'rust' && item.kind === 'type') || (lang === 'swift' && item.open !== undefined && item.kind !== 'func');
    if (nested && item.kind !== 'fn' && item.kind !== 'method') for (const inner of bodyItems(text, tokens, lang, item)) console.log(row(inner, '    '));
  }
}

async function main(argv) {
  const [command, target] = argv;
  if (command === 'outline' && target) { outline(target.replace(/\\/g, '/'), argv.includes('--deep')); return 0; }
  if (command === 'split' && target) return (await import('./native-split.mjs')).runSplit(target, argv.includes('--write'));
  if (command === 'prove') return (await import('./native-proof.mjs')).runProof(argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'HEAD');
  console.error('Usage: native-cli.mjs outline <file> [--deep] | split <plan.json> [--write] | prove [--base <commit>]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
