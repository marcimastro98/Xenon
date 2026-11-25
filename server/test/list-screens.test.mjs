// The screen listing every capture uses: bounds in real pixels, the space gdigrab captures in.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const MODULE = require.resolve('../screens/list-screens.js');

// list-screens.js takes execFile when it loads, so the fake goes in before a fresh require.
function loadWith(fake) {
  mock.method(cp, 'execFile', fake);
  delete require.cache[MODULE];
  try { return require(MODULE); } finally { mock.restoreAll(); }
}

test('the listing turns the thread per-monitor DPI aware before reading the screens, and survives without it', () => {
  const { SCREENS_PS } = require(MODULE);
  const aware = SCREENS_PS.indexOf('SetThreadDpiAwarenessContext([System.IntPtr]::new(-4))');
  assert.ok(aware > 0, 'PER_MONITOR_AWARE_V2 is set');
  assert.ok(SCREENS_PS.indexOf('try {') < aware && SCREENS_PS.indexOf('} catch {}') > aware, 'an old Windows still lists');
  assert.ok(SCREENS_PS.indexOf('Screen]::AllScreens') > SCREENS_PS.indexOf('} catch {}'), 'read after the switch');
});

test('a 4K screen at 150% comes back at its real size, the others as they are', async () => {
  let args = null;
  const { listScreens } = loadWith((_file, a, _opts, cb) => {
    args = a;
    const dev = (n) => String.raw`\\.\DISPLAY` + n;
    cb(null, `573|2160|2560|720|False|${dev(5)}\r\n0|0|3840|2160|True|${dev(1)}\r\n-1080|128|1080|1920|False|${dev(6)}\r\n`);
  });
  const screens = await listScreens();
  assert.match(args.at(-1), /SetThreadDpiAwarenessContext/);
  assert.deepEqual(screens.map((s) => [s.name, s.x, s.y, s.width, s.height, s.primary]), [
    ['DISPLAY5', 573, 2160, 2560, 720, false],
    ['DISPLAY1', 0, 0, 3840, 2160, true],
    ['DISPLAY6', -1080, 128, 1080, 1920, false],
  ]);
});

test('without PowerShell the listing falls back to one 1920x1080 screen', async () => {
  const { listScreens } = loadWith((_file, _a, _opts, cb) => cb(new Error('spawn powershell.exe ENOENT')));
  assert.deepEqual(await listScreens(), [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true, name: 'DISPLAY1' }]);
});

test('GET /api/screens answers with the same listing the captures use', () => {
  const src = readFileSync(new URL('../screens/routes.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/list-screens\.js'\)/);
  assert.match(src, /json\(\{ screens: await listScreens\(\) \}\)/);
  assert.doesNotMatch(src, /powershell/i, 'no second copy of the script');
});
