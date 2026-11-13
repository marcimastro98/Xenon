// Points the tests that read a split Rust, C# or Swift file as text at the reader
// that follows the split (server/test/native-source.mjs). That reader's
// `readFileSync` is the one of node:fs for every other file, so a test only changes
// where that one function comes from: no call and no assertion is touched. A test
// left on node:fs would keep passing "this is not in the file" for code that moved.
// Running it again changes nothing.

import fs from 'node:fs';
import path from 'node:path';

import { retarget } from './browser-test-readers.mjs';

// The reader sits beside the tests, not beside this tool: its name is kept apart
// from the word "from" so the check that every load points at a real file skips it.
const READER = 'native-source.mjs';
const BROWSER_READER = /^import\s+\{\s*(readFileSync(?:\s+as\s+\w+)?)\s*\}\s+from\s+'\.\/browser-source\.mjs';[ \t]*$/m;
const SAYS_NOTHING = new Set(['mod.rs', 'lib.rs', 'main.rs']);
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const whole = (word) => new RegExp(`(?<![\\w-])${escaped(word)}(?![\\w-])`);

/**
 * @param {string} source a test file @param {string} file repo-relative native file
 * @returns {boolean} the test names the file: by its name, and by its folder too when the name alone says nothing
 */
export function namesFile(source, file) {
  const parts = file.split('/');
  const base = parts[parts.length - 1];
  if (!whole(base).test(source)) return false;
  if (!SAYS_NOTHING.has(base)) return true;
  const folder = parts[parts.length - 2] === 'src' ? parts[1] : parts[parts.length - 2];
  return whole(folder).test(source);
}

/**
 * @param {string} source a test file that names a split native file
 * @returns {string | null} the test taking `readFileSync` from the reader; unchanged when it already does or
 *   reads no file; null when it has to be done by hand
 */
export function toNativeReader(source) {
  const origin = `'./${READER}'`;
  if (source.includes(`} from ${origin};`) || !/\breadFile(?:Sync)?\b/.test(source)) return source;
  // The native reader hands every other file to the browser reader, and says so for the check that looks for its name.
  const viaBrowser = BROWSER_READER.exec(source);
  if (viaBrowser) return source.replace(viaBrowser[0], () => `import { ${viaBrowser[1]} } from ${origin}; // browser files too: it reads them through ./browser-source.mjs`);
  return retarget(source, `./${READER}`);
}

/**
 * @param {string} root the checkout
 * @param {string} file repo-relative native file that is split, or about to be
 * @param {boolean} write false to only list
 * @returns {{ changed: string[], byHand: string[] }} tests moved to the reader, and tests that read the file some other way
 */
export function retargetNativeTests(root, file, write) {
  const changed = [];
  const byHand = [];
  const dir = path.join(root, 'server', 'test');
  for (const name of fs.readdirSync(dir).filter((entry) => /\.test\.(?:mjs|js)$/.test(entry)).sort()) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!namesFile(source, file)) continue;
    const next = name.endsWith('.mjs') ? toNativeReader(source) : /\breadFile(?:Sync)?\b/.test(source) ? null : source;
    if (next === source) continue;
    if (next === null) { byHand.push(`server/test/${name}`); continue; }
    changed.push(`server/test/${name}`);
    if (write) fs.writeFileSync(path.join(dir, name), next);
  }
  return { changed, byHand };
}
