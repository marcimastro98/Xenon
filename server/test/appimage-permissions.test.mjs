// "A file inside the AppImage is not executable" — the AppImageHub test of
// Xenon (AppImage/appimage.github.io PR #7417):
//   /run/firejail/appimage/AppRun: line 13: .../AppRun.wrapped: Permission denied
//
// Tauri's bundler stores its AppRun launcher with mode 0770 and it ships in the
// image as AppRun.wrapped (tauri-apps/tauri#16155). Fine when the user who runs
// the image owns it; "Permission denied" when root mounts it and another user
// runs it, as firejail does. The bundler downloads the launcher only when it is
// missing from its cache, so the release job puts it there first, at 0755.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// LF only, so the slices below find their ends on a CRLF (Windows) checkout too.
const WF = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const job = WF.slice(WF.indexOf('\n  native-linux:'), WF.indexOf('\n  publish:'));
const step = (name) => {
  const at = job.indexOf('- name: ' + name);
  assert.ok(at >= 0, `step not found: ${name}`);
  const next = job.indexOf('\n      - name:', at + 1);
  return { at, text: job.slice(at, next < 0 ? undefined : next) };
};

test('the launcher is put in Tauri\'s cache at 0755 before the build runs', () => {
  const seed = step("Give Tauri's AppRun launcher a mode every user can run");
  const build = step('Build the native app (signed updater artifacts)');
  assert.ok(seed.at < build.at, 'the pre-seed must run before the build');
  assert.match(seed.text, /dir="\$\{XDG_CACHE_HOME:-\$HOME\/\.cache\}\/tauri"/, 'Tauri reads dirs::cache_dir()/tauri');
  assert.match(seed.text, /https:\/\/github\.com\/tauri-apps\/binary-releases\/releases\/download\/apprun-old\/AppRun-x86_64/);
  assert.match(seed.text, /-o "\$dir\/AppRun-x86_64"/, 'the name the bundler looks for');
  assert.match(seed.text, /chmod 755 "\$dir\/AppRun-x86_64"/);
});

test('a failed download leaves the build exactly as it was, with a warning', () => {
  const seed = step("Give Tauri's AppRun launcher a mode every user can run").text;
  assert.match(seed, /else\n\s+rm -f "\$dir\/AppRun-x86_64"\n\s+echo "::warning::/, 'a partial file must not be left for the bundler to trust');
  assert.doesNotMatch(seed, /exit 1/);
});

test('the built image is inspected after the build, and only ever warns', () => {
  const check = step('Check that every file in the AppImage can be run by any user');
  assert.ok(step('Build the native app (signed updater artifacts)').at < check.at);
  assert.ok(check.at < step('Stage artifacts and the linux updater fragment').at);
  assert.match(check.text, /--appimage-extract/);
  assert.match(check.text, /find "\$work\/squashfs-root" -type f -perm -u\+x ! -perm -o\+x/, 'owner-only executables');
  assert.match(check.text, /::warning::files in the AppImage that another user cannot run/);
  assert.doesNotMatch(check.text, /exit [1-9]/, 'this job must never block a release: Windows and macOS ship regardless');
});
