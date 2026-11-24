import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksumOf, releaseVersion, sourceJson, DEB_ASSET } from '../../tools/nix/lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEX = 'a'.repeat(64);
const SUMS = `${'b'.repeat(64)}  Xenon-Setup-x64.exe\n${HEX}  ${DEB_ASSET}\r\n${'c'.repeat(64)} *Xenon-Linux-x86_64.rpm\n`;

test('the release version is plain numbers, with or without the v', () => {
  assert.equal(releaseVersion('v5.3.0'), '5.3.0');
  assert.equal(releaseVersion(' 5.3.0\n'), '5.3.0');
  for (const bad of ['', '5.3', '5.3.0-rc1', '5.3.0/../x', null]) assert.throws(() => releaseVersion(bad), /not a release version/);
});

test('the checksum is the .deb line, never a neighbour', () => {
  assert.equal(checksumOf(SUMS, DEB_ASSET), HEX);
  assert.equal(checksumOf(SUMS, 'Xenon-Linux-x86_64.rpm'), 'c'.repeat(64));
  assert.throws(() => checksumOf(SUMS.replace(DEB_ASSET, 'other.deb'), DEB_ASSET), /not in SHA256SUMS/);
});

test('source.json names the tag, the stable .deb and its checksum', () => {
  assert.deepEqual(JSON.parse(sourceJson('v5.3.0', SUMS)), {
    version: '5.3.0',
    url: `https://github.com/marcimastro98/Xenon/releases/download/v5.3.0/${DEB_ASSET}`,
    sha256: HEX,
  });
});

test('the committed source.json has the shape the package reads', () => {
  const source = JSON.parse(fs.readFileSync(path.join(repoRoot, 'nix', 'source.json'), 'utf8'));
  assert.deepEqual(Object.keys(source), ['version', 'url', 'sha256']);
  assert.equal(source.url, `https://github.com/marcimastro98/Xenon/releases/download/v${source.version}/${DEB_ASSET}`);
  assert.match(source.sha256, /^[0-9a-f]{64}$/);
});
