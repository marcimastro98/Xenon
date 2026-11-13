// Turns JavaScript text into a syntax tree with the TypeScript compiler that
// tools/quality installs, so the restructure tools need no dependency of their own.
//
// TypeScript 7 has no parser in JavaScript: its `unstable/sync` API starts the
// compiler and hands back the tree. Text is given through a virtual file system,
// so nothing is written to disk, and every parse gets a fresh file name because
// the compiler keeps the first text it saw under a name.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
const TS_DIR = path.join(REPO_ROOT, 'tools', 'quality', 'node_modules', 'typescript');
const VIRTUAL_ROOT = '/xenon-restructure-parse';

/** @returns {boolean} false until `npm run quality:install` has run in this checkout */
export function parserAvailable() {
  return existsSync(path.join(TS_DIR, 'dist', 'api', 'sync', 'api.js'));
}

const load = (file) => import(pathToFileURL(path.join(TS_DIR, 'dist', file)).href);

/**
 * Starts one compiler for many parses. Call `close()` when done: it is a child process.
 * @returns {Promise<{ K: Record<string, number>, NodeFlags: Record<string, number>,
 *   commentsBefore: (text: string, pos: number) => {pos: number, end: number}[],
 *   parse: (text: string, name?: string) => any, close: () => void }>}
 */
export async function openParser() {
  if (!parserAvailable()) throw new Error('TypeScript is not installed here. Run: npm run quality:install');
  const [{ API }, ast] = await Promise.all([load('api/sync/api.js'), load('ast/index.js')]);
  const files = new Map();
  const api = new API({
    fs: {
      readFile: (file) => (files.has(file) ? files.get(file) : undefined),
      fileExists: (file) => (files.has(file) ? true : undefined),
    },
  });
  let parses = 0;
  return {
    K: ast.SyntaxKind,
    NodeFlags: ast.NodeFlags,
    commentsBefore: (text, pos) => ast.getLeadingCommentRanges(text, pos) ?? [],
    parse(text, name = 'file.js') {
      parses += 1;
      const file = `${VIRTUAL_ROOT}/${parses}/${path.basename(name)}`;
      files.set(file, text);
      const snapshot = api.updateSnapshot({ openFiles: [file] });
      const sourceFile = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
      if (!sourceFile) throw new Error(`the compiler returned no tree for ${name}`);
      if (sourceFile.text !== text) throw new Error(`the compiler read a different text for ${name}`);
      return sourceFile;
    },
    close() { api.close(); },
  };
}
