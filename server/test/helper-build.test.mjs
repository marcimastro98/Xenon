// How the Xenon Helper is built decides what every one of its processes costs, so
// these settings are held by measure (server-widget.md), not by taste. Trimming
// strips the precompiled code out of the framework, and the helper then compiles
// itself again at each start unless ReadyToRun puts that code back. Compression
// makes each process unpack the program into private memory, where an
// uncompressed exe is mapped once and shared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const project = read('helper', 'XenonHelper.csproj').replace(/<!--[\s\S]*?-->/g, '');

function setting(name) {
  const found = new RegExp(`<${name}>([^<]*)</${name}>`).exec(project);
  return found ? found[1].trim() : null;
}

test('the helper is built ahead of time, so a start does not compile it again', () => {
  assert.equal(setting('PublishReadyToRun'), 'true');
});

test('the helper is not compressed, so its processes share one copy in memory', () => {
  assert.equal(setting('EnableCompressionInSingleFile'), null);
});

test('it stays one trimmed exe that needs no .NET on the PC', () => {
  assert.equal(setting('PublishSingleFile'), 'true');
  assert.equal(setting('PublishTrimmed'), 'true');
  assert.equal(setting('SelfContained'), 'true');
});

test('a release builds the helper with those settings, nothing overrides them', () => {
  for (const workflow of ['release.yml', 'helper.yml']) {
    const lines = read('.github', 'workflows', workflow).split(/\r?\n/).filter((line) => line.includes('dotnet publish helper'));
    assert.equal(lines.length, 1, workflow);
    assert.doesNotMatch(lines[0], /\s-p:|\s\/p:|--no-restore/, workflow);
  }
});
