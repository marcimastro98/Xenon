#!/usr/bin/env node
// The Bit Lab: checks and contact sheets for personal Bits (packages/core
// bit-genome, bit-look, bit-wardrobe). See .claude/docs/strumenti.md.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkAll, setDowns } from './checks.mjs';
import { writeSheets } from './sheets.mjs';
import { genome } from './lab.mjs';

const USAGE = `Usage: node tools/bit-lab/cli.mjs <check|sheets> [options]
  check             every rule personal Bits keep: face contrast, markings,
                    antenna tips, wardrobe items in every pose (exit 1 on a problem)
  sheets            PNG sheets (64 random Bits dark and light, 6 people, tips,
                    patterns, palettes, rare looks, wardrobe, moods, moments) + hatch.gif
  --out <dir>       where sheets go (default: <temp>/xenon-bit-lab)
  --seed <word>     another set of random Bits (default: lab)`;

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, seed: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const command = positionals[0];
  if (values.help || !['check', 'sheets'].includes(command)) return { help: true };
  return { command, out: values.out || path.join(tmpdir(), 'xenon-bit-lab'), seed: values.seed || 'lab' };
}

export function runCheck(log = console.log) {
  const problems = checkAll();
  for (const p of problems) log(`  x ${p}`);
  for (const { id, clips } of setDowns()) log(`  ${id} is set down in: ${clips.join(', ')}`);
  log(problems.length ? `${problems.length} problem(s)` : `ok: ${genome.lookCount().toLocaleString('en')} looks, every rule kept`);
  return problems.length ? 1 : 0;
}

async function main() {
  const o = parseCli(process.argv.slice(2));
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  if (o.command === 'check') return runCheck();
  for (const file of await writeSheets(o.out, o.seed)) console.log(file);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}
