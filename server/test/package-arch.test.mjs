// tools/package-arch.mjs builds a pacman package. Only its pure half is tested
// here: importing the module must never build or package anything (an earlier
// version ran cargo and makepkg at import time, i.e. on every `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCH_DEPENDS, ICONS, desktopEntry, pkgVersion, pkgbuild } from '../../tools/package-arch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_TAURI = join(ROOT, 'apps', 'native', 'src-tauri');
const readJson = (...p) => JSON.parse(readFileSync(join(ROOT, ...p), 'utf8'));

test('pkgVersion keeps a release version and makes a pre-release pacman-legal', () => {
  assert.equal(pkgVersion('4.11.11'), '4.11.11');
  assert.equal(pkgVersion('4.11.0-rc1'), '4.11.0_rc1');
  for (const bad of ['', 'abc', '4.11 .1', '4.11;rm', undefined]) {
    assert.throws(() => pkgVersion(bad), /not a usable package version/);
  }
});

test('the PKGBUILD installs everything the app reads at runtime', () => {
  const text = pkgbuild({ version: '4.11.12', description: "Xenon's dashboard" });
  assert.match(text, /^pkgver=4\.11\.12$/m);
  assert.match(text, /^pkgdesc='Xenon'\\''s dashboard'$/m, 'a quote in the description must not end the string');
  for (const dep of ARCH_DEPENDS) assert.ok(text.includes(`'${dep}'`), `depends lists ${dep}`);
  assert.ok(text.includes('"$pkgdir/usr/bin/xenon-native"'));
  assert.ok(text.includes('"$pkgdir/usr/share/licenses/xenon-native/LICENSE"'), 'a custom licence must be installed');
  const sources = text.match(/^source=\((.*)\)$/m)[1].split(' ').length;
  const sums = text.match(/^sha256sums=\((.*)\)$/m)[1].split(' ').length;
  assert.equal(sources, sums, 'one checksum per source');
});

test('the bootstrap lands where Tauri looks for resources', () => {
  // A binary in /usr/bin resolves its resource dir to /usr/lib/<productName>;
  // the PKGBUILD hardcodes that path, so the two must agree.
  const conf = readJson('apps', 'native', 'src-tauri', 'tauri.conf.json');
  const linux = readJson('apps', 'native', 'src-tauri', 'tauri.linux.conf.json');
  assert.equal(conf.productName, 'Xenon');
  assert.ok(linux.bundle.resources.includes('posix/xenon-bootstrap.sh'));
  assert.ok(pkgbuild({ version: '1.0.0', description: 'x' })
    .includes('"$pkgdir/usr/lib/Xenon/posix/xenon-bootstrap.sh"'));
  assert.ok(existsSync(join(SRC_TAURI, 'posix', 'xenon-bootstrap.sh')));
});

test('every icon the package installs exists in the Tauri icon set', () => {
  for (const [file] of ICONS) assert.ok(existsSync(join(SRC_TAURI, 'icons', file)), file);
  const entry = desktopEntry({ comment: 'c' });
  assert.match(entry, /^Exec=xenon-native$/m);
  assert.match(entry, /^Icon=xenon-native$/m);
});

test('the Arch scripts leave the release build untouched', () => {
  const native = readJson('apps', 'native', 'package.json');
  // release.yml's signed Linux job runs this exact command.
  assert.equal(native.scripts['build:linux'], 'NO_STRIP=true tauri build');
  assert.match(native.scripts['build:arch'], /tauri build --no-bundle && node \.\.\/\.\.\/tools\/package-arch\.mjs$/);
  const root = readJson('package.json');
  assert.equal(root.scripts['native:build:arch'], 'npm run build:arch --workspace @xenon/native');
  assert.equal(root.scripts['native:package:arch'], 'node tools/package-arch.mjs');
});
