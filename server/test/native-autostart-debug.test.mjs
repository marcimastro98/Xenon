import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './native-source.mjs';

// One run from the build folder used to rewrite the real Run entry and the login task, and the
// PC then started the unoptimized shell at every sign-in. No Rust test can see this: the tests
// themselves run on a debug build, so it is pinned here.
test('a development build leaves the login entries alone', () => {
  const lib = readFileSync(new URL('../../apps/native/src-tauri/src/lib.rs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = lib.slice(lib.indexOf('pub(crate) fn sync_autostart(app: &tauri::AppHandle) {'));
  const guard = body.indexOf('if cfg!(debug_assertions) {\n        return;\n    }');
  assert.ok(guard > 0, 'the guard is there');
  assert.ok(guard < body.indexOf('app.autolaunch()'), 'and comes before anything touches the entries');
});
