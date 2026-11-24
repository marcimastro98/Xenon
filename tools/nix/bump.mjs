#!/usr/bin/env node
// Points the Nix package at a published release: reads that release's SHA256SUMS
// and rewrites nix/source.json (version, .deb URL, checksum). Run it after the
// release is published, then commit the file.
//
//   node tools/nix/bump.mjs <version>        e.g. 5.3.0
//   node tools/nix/bump.mjs <version> --dry-run
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseUrl, releaseVersion, sourceJson } from './lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = path.join(repoRoot, 'nix', 'source.json');

async function main(argv) {
  const [raw, ...flags] = argv;
  if (!raw) throw new Error('usage: node tools/nix/bump.mjs <version> [--dry-run]');
  const version = releaseVersion(raw);
  const res = await fetch(releaseUrl(version, 'SHA256SUMS'));
  if (!res.ok) throw new Error(`SHA256SUMS of v${version}: HTTP ${res.status} (is the release published?)`);
  const text = sourceJson(version, await res.text());
  if (flags.includes('--dry-run')) {
    process.stdout.write(text);
    return;
  }
  fs.writeFileSync(target, text);
  process.stdout.write(`nix/source.json now points at ${version}\n`);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
