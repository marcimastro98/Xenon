// Stage only part of a shared working tree: the hunks whose changed lines all match a pattern, so
// one session's commit never carries another session's lines from the same file (an i18n file, the
// CHANGELOG). A hunk with matching and other lines is left out and named; --any stages it anyway.
//
//   node tools/stage-hunks.mjs <regex> <file...> [--dry] [--any]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Splits a `git diff -U0` into its files, each with its header lines and its hunks.
 * @param {string} diff
 * @returns {{ name: string, header: string[], hunks: string[][] }[]}
 */
export function parseDiff(diff) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { name: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), header: [line], hunks: [] };
      files.push(file);
      hunk = null;
    } else if (file && line.startsWith('@@')) {
      hunk = [line];
      file.hunks.push(hunk);
    } else if (hunk) {
      hunk.push(line);
    } else if (file) {
      file.header.push(line);
    }
  }
  return files;
}

const changedLines = (hunk) => hunk.slice(1).filter((l) => /^[+-]/.test(l)).map((l) => l.slice(1));

/**
 * The kept hunks with their new-side numbers counted again from the kept ones alone: with no
 * context lines git places an insertion by those numbers, so a hunk left out before it would
 * otherwise push it further down.
 * @param {string[][]} hunks
 */
export function renumber(hunks) {
  let delta = 0;
  return hunks.map((h) => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@(.*)$/.exec(h[0]);
    if (!m) return h;
    const a = Number(m[1]);
    const b = m[2] === undefined ? 1 : Number(m[2]);
    const d = m[3] === undefined ? 1 : Number(m[3]);
    const c = a + delta + (b === 0 ? 1 : 0) - (d === 0 && b > 0 ? 1 : 0);
    delta += d - b;
    const side = (start, n) => (n === 1 ? `${start}` : `${start},${n}`);
    return [`@@ -${side(a, b)} +${side(c, d)} @@${m[4]}`, ...h.slice(1)];
  });
}

/**
 * The patch of the hunks to stage, which files they come from, and the hunks that mix lines.
 * @param {string} diff a `git diff -U0` output
 * @param {RegExp} re tested on each changed line (without its +/-); no `g` flag
 * @param {{ any?: boolean }} [opts] any: a mixed hunk is staged too
 */
export function pickHunks(diff, re, { any = false } = {}) {
  const out = [];
  const kept = [];
  const mixed = [];
  for (const f of parseDiff(diff)) {
    const keep = f.hunks.filter((h) => {
      const lines = changedLines(h);
      const hits = lines.filter((l) => re.test(l)).length;
      if (hits && hits < lines.length) mixed.push({ file: f.name, at: h[0] });
      return hits === lines.length || (any && hits > 0);
    });
    if (!keep.length) continue;
    kept.push({ file: f.name, hunks: keep.length });
    out.push(...f.header, ...renumber(keep).flat());
  }
  return { patch: out.length ? `${out.join('\n')}\n` : '', kept, mixed };
}

function main(argv) {
  const dry = argv.includes('--dry');
  const any = argv.includes('--any');
  const [pattern, ...files] = argv.filter((a) => !a.startsWith('--'));
  if (!pattern || !files.length) {
    console.error('usage: node tools/stage-hunks.mjs <regex> <file...> [--dry] [--any]');
    process.exit(2);
  }
  const diff = execFileSync('git', ['diff', '-U0', '--no-color', '--no-ext-diff', '--', ...files], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const { patch, kept, mixed } = pickHunks(diff, new RegExp(pattern), { any });
  for (const m of mixed) console.log(`mixed, ${any ? 'staged' : 'left out'}: ${m.file} ${m.at}`);
  for (const k of kept) console.log(`${dry ? 'would stage' : 'staged'}: ${k.file} (${k.hunks} hunk${k.hunks === 1 ? '' : 's'})`);
  if (!patch) console.log('nothing matched');
  if (!patch || dry) return;
  execFileSync('git', ['apply', '--cached', '--unidiff-zero', '-'], { input: patch });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
