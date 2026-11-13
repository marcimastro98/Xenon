// File length: a code file stays under LIMIT lines. The files that are already
// longer are listed in baseline/sizes.json with their length, and may only shrink.
//
//   npm run sizes              check
//   npm run sizes -- --update  save the lower numbers after a split

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCounts, nextBaseline } from './ratchet.mjs';
import { REPO_ROOT, trackedFiles } from './repo-files.mjs';

export const LIMIT = 300;
export const BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baseline', 'sizes.json');

const CODE = /\.(js|mjs|cjs|css|html|rs|cs|swift|ps1|sh)$/;
const ROOTS = ['server/', 'packages/', 'apps/', 'helper/', 'helper-mac/', 'integrations/', 'tools/'];
// Not ours, generated, or tests (a long test is a list of cases, not a design problem).
const SKIPPED = [
  /(^|\/)vendor\//, /\.min\./, /(^|\/)test\//, /^server\/sdk-example\//,
  /^server\/soundvolumeview-x64\//, /^apps\/native\/src-tauri\/(gen|target|engine)\//,
  // The app's words, one table per language (server/js/i18n/en.js): a line per
  // string and no logic, so there is nothing to split. Only these files: the
  // code that reads them (js/i18n.js, app-strings/) is counted like any other.
  /^server\/js\/i18n\/[a-z]{2}\.js$/,
];

/** @param {string} file repo-relative path @returns {boolean} */
export function isCounted(file) {
  if (!CODE.test(file)) return false;
  if (!ROOTS.some((root) => file.startsWith(root))) return false;
  return !SKIPPED.some((rule) => rule.test(file));
}

/** @param {string} text @returns {number} lines, counting a last line with no newline */
export function countLines(text) {
  if (text.length === 0) return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/**
 * @param {string[]} files repo-relative paths
 * @param {string} [root]
 * @returns {Record<string, number>} length of every counted file
 */
export function measure(files, root = REPO_ROOT) {
  const sizes = {};
  for (const file of files.filter(isCounted)) {
    sizes[file] = countLines(readFileSync(path.join(root, file), 'utf8'));
  }
  return sizes;
}

export function readBaseline() {
  return JSON.parse(readFileSync(BASELINE, 'utf8')).files ?? {};
}

function saveBaseline(sizes) {
  const files = nextBaseline(sizes, LIMIT);
  const body = {
    note: `Code files longer than ${LIMIT} lines, with their length. Written by tools/quality/sizes.mjs: a number only goes down, and a file leaves the list when it fits.`,
    limit: LIMIT, count: Object.keys(files).length, files,
  };
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
  return body.count;
}

function main(args) {
  const files = trackedFiles();
  if (!files) {
    console.error('No git here: the size check needs the list of tracked files.');
    return 1;
  }
  const sizes = measure(files);
  if (args.includes('--rebase')) {
    console.log(`Saved: ${saveBaseline(sizes)} files are over ${LIMIT} lines.`);
    return 0;
  }
  const { worse, better } = compareCounts(readBaseline(), sizes, LIMIT);
  for (const row of worse) {
    const why = row.was === 0 ? `new file over ${LIMIT} lines` : `grew from ${row.was}`;
    console.log(`  ${row.key}: ${row.now} lines (${why})`);
  }
  if (worse.length > 0) {
    console.log('\nSplit the file by responsibility, or move the new code to its own module.');
    return 1;
  }
  if (args.includes('--update')) {
    console.log(`Saved: ${saveBaseline(sizes)} files are still over ${LIMIT} lines.`);
    return 0;
  }
  console.log(`Sizes: nothing grew (${Object.keys(readBaseline()).length} files still over ${LIMIT} lines).`);
  if (better.length > 0) console.log(`${better.length} files got shorter. Save them with: npm run sizes -- --update`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
