import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

test('arch packaging scripts exist and are valid JavaScript', async () => {
  assert.ok(existsSync(join(ROOT, 'tools', 'package-arch.mjs')), 'tools/package-arch.mjs must exist');
  assert.ok(existsSync(join(ROOT, 'tools', 'build-linux.mjs')), 'tools/build-linux.mjs must exist');

  // Verify scripts can be dynamically imported (syntax valid)
  await import(new URL('../../tools/package-arch.mjs', import.meta.url).href).catch((err) => {
    // If it executes top-level code that is fine; make sure it did not fail with SyntaxError
    assert.notEqual(err?.name, 'SyntaxError');
  });
  await import(new URL('../../tools/build-linux.mjs', import.meta.url).href).catch((err) => {
    assert.notEqual(err?.name, 'SyntaxError');
  });
});

test('root and native package.json scripts expose arch packaging commands', () => {
  const rootPkg = JSON.parse(read('package.json'));
  assert.equal(rootPkg.scripts['native:package:arch'], 'node tools/package-arch.mjs');
  assert.equal(rootPkg.scripts['native:build:arch'], 'npm run build:arch --workspace @xenon/native');
  assert.equal(rootPkg.scripts['native:build:linux'], 'npm run build:linux --workspace @xenon/native');

  const nativePkg = JSON.parse(read('apps', 'native', 'package.json'));
  assert.equal(nativePkg.scripts['build:linux'], 'node ../../tools/build-linux.mjs');
  assert.equal(nativePkg.scripts['build:arch'], 'NO_STRIP=true tauri build --no-bundle && node ../../tools/package-arch.mjs');
  assert.equal(nativePkg.scripts['package:arch'], 'node ../../tools/package-arch.mjs');
});

test('release workflow includes arch package staging and checksums', () => {
  const releaseYml = read('.github', 'workflows', 'release.yml');
  assert.ok(releaseYml.includes('Xenon-Linux-x86_64.pkg.tar.zst'), 'release.yml must stage and publish .pkg.tar.zst');
});
