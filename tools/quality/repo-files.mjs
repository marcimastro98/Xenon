// The files that are part of the repo, as repo-relative paths with forward slashes:
// what git tracks, plus new files it does not ignore (so a file is checked before
// its first commit), minus files deleted on disk.
// The checks read this list instead of walking the disk: the disk also holds
// downloaded tools, build output and user data that are not part of the code.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function gitList(root, flags) {
  const out = execFileSync('git', ['ls-files', '-z', ...flags], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\0').filter(Boolean);
}

/**
 * @param {string} [root]
 * @returns {string[] | null} null when this copy has no git (a tar of the tree, an install)
 */
export function trackedFiles(root = REPO_ROOT) {
  try {
    const deleted = new Set(gitList(root, ['--deleted']));
    const present = gitList(root, ['--cached', '--others', '--exclude-standard']);
    return [...new Set(present)].filter((file) => !deleted.has(file)).sort();
  } catch {
    return null;
  }
}
