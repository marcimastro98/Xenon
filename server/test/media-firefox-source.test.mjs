// Firefox gives Windows a hash of its install folder as its media source
// ("308046B0AF4A39CB" for the default one) instead of its name. The music tile
// showed that hash where the app's name goes (#154); it must read as Firefox,
// and through Firefox as the site playing in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';

const src = readFileSync(new URL('../js/media/media.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function grab(re, what) {
  const m = re.exec(src);
  assert.ok(m, `${what} is in js/media/`);
  return m[0];
}

function load(speakerApps) {
  const code = [
    grab(/const BROWSER_SOURCE_RE = [^\n]*\n/, 'BROWSER_SOURCE_RE'),
    grab(/const MEDIA_SITE_PATTERNS = \[[\s\S]*?\n\];\n/, 'MEDIA_SITE_PATTERNS'),
    grab(/const BROWSER_LABELS = \[[\s\S]*?\n\];\n/, 'BROWSER_LABELS'),
    grab(/const FIREFOX_SOURCE_RE = [^\n]*\n/, 'FIREFOX_SOURCE_RE'),
    grab(/function browserSourceName\([\s\S]*?\n\}\n/, 'browserSourceName'),
    grab(/function browserMediaSessions\([\s\S]*?\n\}\n/, 'browserMediaSessions'),
    grab(/let _browserSiteMemo = [^\n]*\n/, '_browserSiteMemo'),
    grab(/function browserStreamKey\([\s\S]*?\n\}\n/, 'browserStreamKey'),
    grab(/function refineBrowserApp\([\s\S]*?\n\}\n/, 'refineBrowserApp'),
    'globalThis.refineBrowserApp = refineBrowserApp;',
  ].join('\n');
  const ctx = vm.createContext({ audioData: { speakerApps } });
  vm.runInContext(code, ctx);
  return ctx.refineBrowserApp;
}

const HASH = '308046B0AF4A39CB';

test('a Firefox hash with the site in the window title reads as the site', () => {
  const refine = load([{ proc: 'firefox', win: 'lofi hip hop radio - YouTube — Mozilla Firefox' }]);
  assert.equal(refine({ source: HASH, app: HASH, title: 'study to', artist: 'Lofi Girl' }, false), 'YouTube');
});

test('a Firefox hash with no known site reads as Firefox', () => {
  assert.equal(load([])({ source: HASH, app: HASH, title: 'a podcast' }, false), 'Firefox');
  // Another install folder gives another hash: still Firefox.
  assert.equal(load([])({ source: 'a1b2c3d4e5f60718', app: 'x', title: 't' }, false), 'Firefox');
});

test('sources that are not a sixteen-digit hash are left alone', () => {
  const refine = load([]);
  assert.equal(refine({ source: 'Spotify.exe', app: 'Spotify', title: 't' }, false), 'Spotify');
  assert.equal(refine({ source: '308046B0AF4A39CB0', app: 'Other', title: 't' }, false), 'Other');
  assert.equal(refine({ source: '308046B0AF4A39CG', app: 'Other', title: 't' }, false), 'Other');
});
