// Points the tests that read a split browser file as text at the reader that
// follows the split (server/test/browser-source.mjs). The reader has a
// `readFileSync` that is the one of node:fs for every other file, so a test only
// changes where that one function comes from: no call and no assertion is touched.
// Running it again changes nothing.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { mentionsOf } from './browser-consumers.mjs';

// The reader sits beside the tests, not beside this tool, so its name is kept
// apart from the word "from": the check that every load points at a real file
// would otherwise look for it here.
const READER = 'browser-source.mjs';
const FS_IMPORT = /^import\s+\{([^}]*)\}\s+from\s+'(?:node:)?fs';[ \t]*$/gm;
const FS_OBJECT = /^import\s+(?:\*\s+as\s+)?fs\s+from\s+'(?:node:)?fs';[ \t]*$/m;
const FS_LATER = /const \{ readFileSync \} = await import\('(?:node:)?fs'\);/g;
const IS_READ = /^readFileSync(?:\s+as\s+\w+)?$/;

/**
 * @param {string} source a test file
 * @param {string} readerPath how the test names the reader (`./browser-source.mjs`)
 * @returns {string | null} the same test taking `readFileSync` from the reader; the text unchanged when it
 *   already does; null when it has to be done by hand
 */
export function retarget(source, readerPath) {
  const origin = `'${readerPath}'`;
  if (source.includes(`} from ${origin};`) || source.includes(`await import(${origin})`)) return source;
  for (const named of source.matchAll(FS_IMPORT)) {
    const names = named[1].split(',').map((name) => name.trim()).filter(Boolean);
    const mine = names.find((name) => IS_READ.test(name));
    if (!mine) continue;
    const rest = names.filter((name) => name !== mine);
    const kept = rest.length ? `import { ${rest.join(', ')} } from ${named[0].slice(named[0].lastIndexOf(' ') + 1)}\n` : '';
    return source.replace(named[0], () => `${kept}import { ${mine} } from ${origin};`);
  }
  if (source.search(FS_LATER) !== -1) return source.replace(FS_LATER, () => `const { readFileSync } = await import(${origin});`);
  const whole = FS_OBJECT.exec(source);
  // `fs.readFileSync(...)` becomes `readFileSync(...)`, unless the test has a `readFileSync` of its own.
  if (!whole || !source.includes('fs.readFileSync(') || /\b(?:const|let|function)\s+readFileSync\b/.test(source)) return null;
  return source.replace(whole[0], () => `${whole[0]}\nimport { readFileSync } from ${origin};`).replaceAll('fs.readFileSync(', 'readFileSync(');
}

/**
 * @param {string} root
 * @param {string} file repo-relative browser file that is split, or about to be
 * @param {boolean} write false to only list
 * @returns {{ changed: string[], byHand: string[] }} tests moved to the reader, and tests that name the file but could not be
 */
export function retargetTests(root, file, write) {
  const changed = [];
  const byHand = [];
  for (const mention of mentionsOf(root, file)) {
    if (mention.kind !== 'test' || mention.reader) continue;
    const place = path.join(root, mention.file);
    const source = readFileSync(place, 'utf8');
    const toReader = path.posix.relative(path.posix.dirname(mention.file), `server/test/${READER}`);
    const next = /\.mjs$/.test(mention.file) ? retarget(source, toReader.startsWith('.') ? toReader : `./${toReader}`) : null;
    if (next === null || next === source) { byHand.push(mention.file); continue; }
    changed.push(mention.file);
    if (write) writeFileSync(place, next);
  }
  return { changed, byHand };
}
