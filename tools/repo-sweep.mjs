#!/usr/bin/env node
// Repeatable sweeps of the repo, which is public: what nobody uses any more, and
// what must never be published.
//
//   node tools/repo-sweep.mjs media [--dir docs/images]... [--rev main]... [--no-tags] [--also ../other-repo]...
//   node tools/repo-sweep.mjs functions [--dir server]...
//   node tools/repo-sweep.mjs i18n [--remove [--skip <key prefix>]...]
//   node tools/repo-sweep.mjs personal [--words <private file>] [--show]
//   any of them: --json
//
// media, functions and i18n only report (i18n --remove deletes the unused keys,
// see tools/repo-sweep/i18n.mjs). personal exits 1 when it finds anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mask } from './repo-sweep/personal.mjs';
import { sweepFunctions, sweepI18n, sweepMedia, sweepPersonal } from './repo-sweep/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) values.push(argv[++i]);
  return values;
}

function printList(title, rows, format) {
  if (!rows.length) return;
  console.log(`\n${title} (${rows.length})`);
  for (const row of rows) console.log(`  ${format(row)}`);
}

const COMMANDS = {
  media(argv) {
    const dirs = option(argv, '--dir');
    const r = sweepMedia(ROOT, {
      dirs: dirs.length ? dirs : undefined, revs: option(argv, '--rev'), tags: !argv.includes('--no-tags'), also: option(argv, '--also'),
    });
    if (argv.includes('--json')) return console.log(JSON.stringify(r, null, 2));
    console.log(`${r.scanned} media files read`);
    printList('Unused', r.unused, (x) => x.file);
    printList('Named only by tools/ or tests', r.toolsOnly, (x) => x.file);
    printList('Maybe built at runtime', r.maybe, (x) => `${x.file}  ~ /${x.pattern}/ (${x.example})`);
  },
  functions(argv) {
    const r = sweepFunctions(ROOT, { dirs: option(argv, '--dir') });
    if (argv.includes('--json')) return console.log(JSON.stringify(r, null, 2));
    printList('Never called', r.dead, (x) => `${x.file}:${x.line}  ${x.name}`);
    printList('Called only by tests', r.onlyTests, (x) => `${x.file}:${x.line}  ${x.name}`);
    printList('Exported, no other file uses it', r.unusedExports, (x) => `${x.file}  ${x.name}${x.ownUses ? '' : '  (not used in its own file either)'}`);
  },
  i18n(argv) {
    const r = sweepI18n(ROOT, { remove: argv.includes('--remove'), skip: option(argv, '--skip') });
    if (argv.includes('--json')) return console.log(JSON.stringify(r, null, 2));
    printList('Unused', r.unused, (x) => x.key);
    printList('Used only by tests', r.onlyTests, (x) => x.key);
    printList('Maybe built at runtime', r.maybe, (x) => `${x.key}  ~ /${x.pattern}/ (${x.example})`);
    if (r.removed) console.log(`\nRemoved from every language: ${r.removed.length}`);
    if (r.keptNew?.length) console.log(`Kept, not committed yet (maybe being wired up): ${r.keptNew.join(', ')}`);
    if (r.keptSkipped?.length) console.log(`Kept by --skip: ${r.keptSkipped.join(', ')}`);
  },
  personal(argv) {
    const words = option(argv, '--words').flatMap((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    const findings = sweepPersonal(ROOT, { words });
    if (argv.includes('--json')) console.log(JSON.stringify(findings, null, 2));
    else {
      const show = argv.includes('--show') ? (v) => v : mask;
      for (const f of findings) console.log(`${f.file}${f.line ? `:${f.line}` : ''}  ${f.kind}  ${show(f.value)}`);
      console.log(findings.length ? `\n${findings.length} finding(s): invent the values (see .claude/CLAUDE.md, Public repo)` : 'no personal data found');
    }
    if (findings.length) process.exitCode = 1;
  },
};

function main(argv) {
  const command = COMMANDS[argv[0]];
  if (!command) {
    console.error('usage: node tools/repo-sweep.mjs <media|functions|i18n|personal> [options]');
    process.exit(2);
  }
  command(argv.slice(1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
