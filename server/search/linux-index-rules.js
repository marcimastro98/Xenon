'use strict';
// What the Linux index walks by: the folders never searched, the paths that are not really
// files, how deep a measured folder is recorded, and the file system calls that return a
// promise.

const fs = require('node:fs');

const fsp = fs.promises;

// Directory names never worth SEARCHING: caches and build output, which are
// large, numerous, and never what someone types a filename to find. They are
// still MEASURED (see sizeWalk): they are exactly what the disk widget's
// cleanup categories are about, and skipping them outright meant browser
// caches, package caches, build output and the Trash could never appear on
// Linux at all.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '__pycache__',
  '.venv', 'venv', '.tox', '.gradle', '.m2', '.npm', '.cargo', '.rustup',
  'target', '.next', '.nuxt', '.turbo', 'dist-cache', '.pnpm-store',
  '.local/share/Trash', 'Trash',
]);

// Absolute prefixes that are not really files: kernel and runtime interfaces
// where a walk either loops, blocks, or reports sizes that mean nothing.
const SKIP_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker'];

// A measured-only subtree is recorded as one row per directory down to this
// depth below the skipped folder, deeper folders folding into their ancestor.
// Deep enough for every POSIX category path in disk-categories.js
// (~/.cache/google-chrome/Default/Cache is 3 below .cache), shallow enough that
// a node_modules tree costs a few hundred rows instead of its 100k files.
const AGG_DEPTH = 5;

function isSkippedPath(abs) {
  for (const p of SKIP_PREFIXES) {
    if (abs === p || abs.startsWith(p + '/')) return true;
  }
  return false;
}

module.exports = { fsp, SKIP_DIRS, SKIP_PREFIXES, AGG_DEPTH, isSkippedPath };
