// The pure half of tools/dev-install/snapshot.mjs, tested in server/test/dev-install.test.mjs.

/**
 * The command line, read strictly like cli.mjs: an unknown flag stops the tool.
 * @param {string[]} argv
 * @returns {{ help: true } | { error: string } | { base: string, skip: string[], dryRun: boolean }}
 */
export function parseSnapshotArgs(argv) {
  const out = { base: 'HEAD', skip: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--base' || a === '--skip') {
      const v = argv[i + 1];
      if (!v || v.startsWith('-')) return { error: `${a} needs a value` };
      if (a === '--base') out.base = v;
      else out.skip.push(v.replace(/\\/g, '/').replace(/\/+$/, ''));
      i++; continue;
    }
    return { error: 'unknown argument: ' + a };
  }
  return out;
}

/**
 * Which working files go into the snapshot: every changed or untracked one, unless a skip
 * names it or a folder it sits in. A skip is a path, never a pattern, so `server/a` does not
 * skip `server/ab.js`.
 * @param {string[]} changed
 * @param {string[]} untracked
 * @param {string[]} skip
 */
export function pickPaths(changed, untracked, skip) {
  const skips = (file) => skip.some((s) => file === s || file.startsWith(s + '/'));
  const all = [...new Set([...changed, ...untracked])].sort();
  return { take: all.filter((f) => !skips(f)), skipped: all.filter(skips) };
}
