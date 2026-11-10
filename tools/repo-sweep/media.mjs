// Pictures, videos and sounds nothing points at. A file counts as used when its
// name, or its name without the extension, is a whole token of a text file
// outside tools/ and the tests (an HTML src, a CSS url(), a JS string, a JSON
// entry), or when its name shows up in the tree of a release tag or a --rev
// revision: a shipped app can load a site picture by URL long after main stopped
// mentioning it (4.10's What's New reads its pictures from main on GitHub).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtNamePatterns } from './built-names.mjs';
import { isTestFile, MEDIA_EXT } from './files.mjs';

const TOKEN = /[A-Za-z0-9_.@-]+/g;

// Generators and tests name the pictures they make or check; that is not a use.
export const isProducer = (rel) => rel.startsWith('tools/') || isTestFile(rel);

export function tokenSet(texts) {
  const tokens = new Set();
  for (const text of texts.values()) {
    for (const [token] of text.matchAll(TOKEN)) {
      tokens.add(token);
      const bare = token.replace(/^\.+|\.+$/g, '');
      if (bare !== token) tokens.add(bare);
    }
  }
  return tokens;
}

export const mediaUnder = (files, dirs) => files.filter((rel) => MEDIA_EXT.has(path.posix.extname(rel).toLowerCase())
  && dirs.some((dir) => rel.startsWith(`${dir.replace(/\/+$/, '')}/`)));

const nameParts = (rel) => {
  const base = path.posix.basename(rel);
  return [base, base.replace(/\.[^.]+$/, '')];
};

// An SVG is text too: its own content must not count as a use of itself.
function usedOutsideItself(name, rel, texts) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^A-Za-z0-9_.@-])\\.*${escaped}\\.*(?:$|[^A-Za-z0-9_.@-])`, 'm');
  for (const [other, text] of texts) if (other !== rel && !isProducer(other) && re.test(text)) return true;
  return false;
}

// { unused, toolsOnly, maybe }: `maybe` carries the runtime pattern that could build the name.
export function classifyMedia({ media, texts, revNames = new Set(), extraTexts = new Map() }) {
  const consumers = new Map([...extraTexts]);
  const producers = new Map();
  for (const [rel, text] of texts) (isProducer(rel) ? producers : consumers).set(rel, text);
  const used = tokenSet(consumers);
  const producerTokens = tokenSet(producers);
  const patterns = builtNamePatterns(consumers, { nameChars: 'A-Za-z0-9_.@-', minStatic: 2, ignoreExt: true });
  const result = { unused: [], toolsOnly: [], maybe: [] };
  for (const rel of media) {
    const [base, stem] = nameParts(rel);
    if (revNames.has(base)) continue;
    const hits = [base, stem].filter((n) => used.has(n));
    if (hits.length && (!texts.has(rel) || hits.some((n) => usedOutsideItself(n, rel, consumers)))) continue;
    const pattern = patterns.find((p) => p.re.test(base));
    if (pattern) { result.maybe.push({ file: rel, pattern: pattern.source, example: pattern.example }); continue; }
    if (producerTokens.has(base) || producerTokens.has(stem)) { result.toolsOnly.push({ file: rel }); continue; }
    result.unused.push({ file: rel });
  }
  return result;
}

// Release tags: each one is an app somebody may still run. Only the folders an
// installed app runs from matter there: an old tag's site pages are not served.
export const SHIPPED_PATHS = ['server', 'apps', 'widget', 'packages'];
export function releaseTags(root) {
  return execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
}

// File names (from `names`, with their extension: a bare stem like "disk" is
// in every tree) that appear as whole words in the trees of `revs`, limited to
// `paths` when given, in one git grep.
export function namesInRevisions(root, revs, names, paths = []) {
  if (!names.length || !revs.length) return new Set();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sweep-'));
  const list = path.join(dir, 'names.txt');
  fs.writeFileSync(list, `${names.join('\n')}\n`);
  try {
    const out = execFileSync('git', ['grep', '-I', '-h', '-o', '-w', '-F', '-f', list, ...revs, '--', ...paths], {
      cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch (err) {
    if (err.status === 1) return new Set();
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
