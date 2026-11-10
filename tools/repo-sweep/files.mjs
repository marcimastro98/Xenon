// Which files a sweep reads: what git tracks plus new files nobody has committed
// yet (another session's work in progress still counts as a reference), never
// what .gitignore keeps out: server/data holds the user's own notes and contacts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.icns', '.bmp', '.tif', '.tiff', '.heic',
  '.mp4', '.webm', '.mov', '.mkv', '.avi', '.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.gz', '.tgz', '.7z', '.rar', '.tar', '.br', '.zst',
  '.dll', '.exe', '.pdb', '.so', '.dylib', '.node', '.wasm', '.bin', '.dat', '.pdf', '.psd', '.blend',
  '.glb', '.fbx', '.msi', '.msix', '.appx', '.cab', '.jar', '.class', '.pyc', '.sqlite', '.db', '.icuewidget',
]);

export const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg']);

// A text file larger than this is listed as skipped, never read silently past.
export const MAX_TEXT_BYTES = 16 * 1024 * 1024;

export function listRepoFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const files = new Set();
  for (const rel of out.split('\0')) {
    if (!rel || files.has(rel)) continue;
    try {
      if (fs.statSync(path.join(root, rel)).isFile()) files.add(rel);
    } catch {
      // Listed by git but deleted in the working tree: nothing to read.
    }
  }
  return [...files].sort();
}

export const isTestFile = (rel) => /(^|\/)test\//.test(rel) || /\.(test|spec)\.[cm]?[jt]s$/.test(rel);

// Reads every text file of `files`: { texts: Map(rel -> content), skipped: [rel] }.
export function readTextFiles(root, files) {
  const texts = new Map();
  const skipped = [];
  for (const rel of files) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(root, rel);
    if (fs.statSync(abs).size > MAX_TEXT_BYTES) { skipped.push(rel); continue; }
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) continue;
    texts.set(rel, buf.toString('utf8'));
  }
  return { texts, skipped };
}

function walkFolder(dir) {
  const files = [];
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const next = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.push(path.relative(dir, next).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return files;
}

// Every text file under an extra folder, for --also. Another repo gives its own
// files as git sees them: the build output it ignores (a minified bundle seems
// to build every name) stays out. A plain folder is read whole.
export function readFolderTexts(dir) {
  if (fs.statSync(dir).isFile()) return readTextFiles(path.dirname(dir), [path.basename(dir)]).texts;
  let files;
  try {
    files = listRepoFiles(dir);
  } catch {
    files = walkFolder(dir);
  }
  return readTextFiles(dir, files).texts;
}
