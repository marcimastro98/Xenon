// The submit form's fill from the package (docs/submit/manifest.js): a widget's or
// Ambient scene's manifest.json gives the listing its version, description and
// category, and anything odd in it is left for the creator to type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'docs', 'submit');
const js = readFileSync(path.join(DIR, 'manifest.js'), 'utf8');
const html = readFileSync(path.join(DIR, 'index.html'), 'utf8');
const CATS = ['style', 'deck', 'streaming', 'media', 'smart-home', 'system', 'tools', 'fun'];

function load() {
  const win = {};
  vm.runInNewContext(js, { window: win, atob, TextDecoder, Uint8Array, JSON, Array, String });
  return win.XenonSubmitManifest;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const env = (manifest, kind = 'widget') => ({
  xenonPreset: 1,
  kind,
  data: {
    id: 'radar-x',
    payload: {
      files: [
        { path: 'index.html', data: b64('<!doctype html>') },
        { path: 'manifest.json', data: typeof manifest === 'string' ? manifest : b64(JSON.stringify(manifest)) },
      ],
    },
  },
});

test('a widget states its version, description and category', () => {
  const m = load().read(
    env({ version: '1.0.0', description: 'Carte sombre avec radar de pluie animé.', category: 'system' }),
    CATS,
  );
  assert.deepEqual({ ...m }, {
    version: '1.0.0',
    description: 'Carte sombre avec radar de pluie animé.',
    category: 'system',
  });
  assert.equal(load().read(env({ version: '2.1.0' }, 'ambient'), CATS).version, '2.1.0');
});

test('anything the form would not take is left empty', () => {
  const read = load().read;
  assert.deepEqual({ ...read(env({ version: 'v1 beta', category: 'weather', description: 7 }), CATS) }, {
    version: '',
    description: '',
    category: '',
  });
  assert.equal(read(env({ description: 'x'.repeat(900) }), CATS).description.length, 800);
  for (const bad of [env('!!not base64 json'), env({}, 'theme'), null, { kind: 'widget' }]) {
    assert.deepEqual({ ...read(bad, CATS) }, { version: '', description: '', category: '' });
  }
});

test('the form loads it and fills only the fields still empty', () => {
  assert.match(html, /<script src="manifest\.js"><\/script>/);
  const fill = html.slice(html.indexOf('function fillFromManifest'), html.indexOf('function syncFromCode()'));
  assert.match(fill, /!versionEl\.value\.trim\(\)/);
  assert.match(fill, /!descEl\.value\.trim\(\)/);
  assert.match(fill, /!catSel\.value/);
  assert.match(html, /fillFromManifest\(env\);/);
});
