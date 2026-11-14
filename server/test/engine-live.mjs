// A function of the engine to call, wherever it lives now.
// server.js cannot be loaded by a test: it starts the whole engine. A function that has a
// module of its own is simply required. One that is still in server.js is taken out the way
// tools/restructure `extract --with-deps` would take it out, without writing anything: the
// module text is planned in memory, then run as the module it would be, so its requires
// find the same files. The same call gives the same function before and after a move.
//
// The plan needs the parser that `npm run quality:install` installs: without it, a
// function that is still in server.js is not handed out (null), and the test says so.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { planExtraction } from '../../tools/restructure/extract-plan.mjs';
import { createSpecRewriter } from '../../tools/restructure/module-requires.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { fileDeclaring } from './engine-source.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = 'server/server.js';

export const NO_PARSER = 'the function is still in server.js and the parser is not installed (npm run quality:install)';

/**
 * The text of the module `name` would be with everything it needs, when it is still in `source`.
 * @param {string} name @param {string} source repo-relative @param {string} target repo-relative, where the module would be
 * @returns {Promise<string>}
 */
export async function moduleTextOf(name, source, target) {
  const text = readFileSync(path.join(REPO, source), 'utf8');
  const parser = await openParser();
  try {
    return planExtraction({ text, analysis: analyze(text, parser, source), names: [name], source, target,
      about: `${name} and what it needs.`, withDeps: true, rewrite: createSpecRewriter(REPO), maxLines: Infinity }).moduleText;
  } finally {
    parser.close();
  }
}

/** Runs a CommonJS module text as the file `target` (repo-relative) would run. @returns {Record<string, unknown>} its exports */
export function runModuleText(moduleText, target) {
  const filename = path.join(REPO, target);
  const module = { exports: {} };
  const run = vm.compileFunction(moduleText, ['exports', 'require', 'module', '__filename', '__dirname'], { filename });
  run(module.exports, createRequire(filename), module, filename, path.dirname(filename));
  return module.exports;
}

/**
 * @param {string} name a top-level function of the engine
 * @param {{ source?: string, beside?: string }} [options] `beside`: a module in the folder the function would move to
 * @returns {Promise<Function | null>} null when it is still in the engine and the parser is not installed
 */
export async function liveFunction(name, { source = ENGINE, beside = 'server/settings/values.js' } = {}) {
  const file = fileDeclaring(name, source);
  if (file !== source) return createRequire(import.meta.url)(path.join(REPO, file))[name];
  if (!parserAvailable()) return null;
  const target = path.posix.join(path.posix.dirname(beside), `live-${name}.js`);
  const made = runModuleText(await moduleTextOf(name, source, target), target)[name];
  if (typeof made !== 'function') throw new Error(`${name} is not a function of ${source}`);
  return made;
}
