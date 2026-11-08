// The update zip is GitHub's archive of the release tag: `git archive` minus every
// path .gitattributes marks export-ignore. self-update.js downloads it and the
// applier copies all of it into the install root, so the website must stay out
// and the docs the app reads from disk must stay in. INSTALL.bat must reach
// users with CRLF: cmd.exe can lose goto/call labels in an LF-only batch file.
// This runs the real `git archive` with the working tree's .gitattributes and
// GitHub's line endings (no autocrlf), so what is checked is what users unpack.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Read from disk by the installed app: server/ai-knowledge.js (sdk_reference).
const RUNTIME_DOCS = ['docs/WIDGET_SDK.md'];
// The developer guides README.md links to; nothing else under docs/ may ship.
const SHIPPED_DOC = /^docs\/[^/]+\.md$/;
const BATCH = /\.(bat|cmd)$/i;

const git = (args, input) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args],
  { cwd: ROOT, input, maxBuffer: 256 * 1024 * 1024 });

function hasHead() {
  try {
    git(['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}
const needsGit = { skip: !hasHead() && 'needs a git checkout with a commit' };

// Regular files of a ustar stream, by path. git writes long paths in a pax
// extended header ('x') and the commit id in a global one ('g').
function tarFiles(buf) {
  const files = new Map();
  let longPath = null;
  for (let off = 0; off + 512 <= buf.length;) {
    const head = buf.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break;
    const field = (start, len) => head.subarray(start, start + len).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { longPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null; continue; }
    if (type === 'g') continue;
    const prefix = field(345, 155);
    const name = longPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longPath = null;
    if (type === '0') files.set(name, body);
  }
  return files;
}

function archive() {
  const batch = git(['ls-tree', '-r', '--name-only', 'HEAD']).toString('utf8').split('\n').filter((f) => BATCH.test(f));
  return tarFiles(git(['archive', '--worktree-attributes', '--format=tar', 'HEAD', '--', 'docs', ...batch]));
}

test('the update zip carries no page of the website, only the docs the app reads', needsGit, () => {
  const files = archive();
  const site = [...files.keys()].filter((f) => f.startsWith('docs/') && !SHIPPED_DOC.test(f));
  assert.deepEqual(site, [], 'export-ignore these in .gitattributes, nothing on an install reads them');
  for (const doc of RUNTIME_DOCS) assert.ok(files.has(doc), `${doc} is read at runtime and must ship`);
});

test('docs files not committed yet fall under the same rule', needsGit, () => {
  // git archive skips a whole directory marked export-ignore, so a file is out
  // when it or any folder above it is; check-attr matches folder patterns on
  // paths ending in "/".
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'docs'])
    .toString('utf8').split('\0').filter(Boolean);
  const folders = (f) => f.split('/').slice(0, -1).map((_, i, parts) => `${parts.slice(0, i + 1).join('/')}/`);
  const asked = [...new Set([...files, ...files.flatMap(folders)])];
  const out = git(['check-attr', '--stdin', '-z', 'export-ignore'], asked.join('\0')).toString('utf8').split('\0');
  const ignored = new Set();
  for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'set') ignored.add(out[i]);
  const ships = (f) => !ignored.has(f) && !folders(f).some((d) => ignored.has(d));
  const site = files.filter((f) => ships(f) && !SHIPPED_DOC.test(f));
  assert.deepEqual(site, [], 'export-ignore these in .gitattributes, nothing on an install reads them');
  for (const doc of RUNTIME_DOCS) assert.ok(ships(doc), `${doc} is read at runtime and must ship`);
});

test('batch files reach users with CRLF line endings', needsGit, () => {
  const files = archive();
  const batch = [...files.keys()].filter((f) => BATCH.test(f));
  assert.ok(batch.includes('INSTALL.bat'), 'INSTALL.bat ships');
  for (const f of batch) {
    const text = files.get(f).toString('latin1');
    assert.ok(text.includes('\r\n') && !/(^|[^\r])\n/.test(text), `${f} ships with LF-only lines: add "*.bat text eol=crlf"`);
  }
});
