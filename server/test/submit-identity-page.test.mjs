// The submit form's Discord sign-in (docs/submit/identity.js): every site language
// carries every line, /submit's identity_* answers become a message, and the form
// sends the sign-in instead of a typed contact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'docs', 'submit');
const js = readFileSync(path.join(DIR, 'identity.js'), 'utf8');
const html = readFileSync(path.join(DIR, 'index.html'), 'utf8');

function load() {
  const listeners = [];
  const win = { addEventListener: (...a) => listeners.push(a) };
  const sandbox = {
    window: win, document: { addEventListener() {}, visibilityState: 'visible' },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: { getRandomValues: (a) => a, subtle: { digest: async () => new ArrayBuffer(32) } },
    TextEncoder, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), setTimeout, clearTimeout,
  };
  vm.runInNewContext(js, sandbox);
  return win.XenonSubmitIdentity;
}

test('every site language carries every sign-in line', () => {
  const start = js.indexOf('var WORDS = {');
  const end = js.indexOf('\n  };', start) + 5;
  assert.ok(start > 0 && end > start);
  const words = vm.runInNewContext(js.slice(start, end) + ' WORDS;', {});
  assert.deepEqual(Object.keys(words).sort(), ['en', 'es', 'fr', 'it', 'ja', 'ko', 'zh']);
  const keys = Object.keys(words.en).sort();
  for (const [l, d] of Object.entries(words)) {
    assert.deepEqual(Object.keys(d).sort(), keys, l);
    for (const k of keys) {
      assert.ok(d[k].trim(), l + '.' + k);
      assert.ok(!d[k].includes('—'), l + '.' + k + ' has an em-dash');
    }
  }
});

test('a refused or spent sign-in from /submit becomes a message, anything else is left to the form', () => {
  const id = load();
  assert.match(id.errorText('identity_required'), /Sign in with Discord first/);
  assert.match(id.errorText('identity_expired'), /expired/);
  assert.match(id.errorText('identity_not_member'), /not in the Xenon server/);
  assert.equal(id.errorText('rate_limited'), '');
  // Nothing is sent before Discord said yes.
  assert.equal(id.secret(), '');
});

test('the form sends the sign-in, never a typed contact', () => {
  assert.ok(!/id="contact"/.test(html));
  assert.ok(!/fd\.append\('contact'/.test(html));
  assert.match(html, /fd\.append\('identity', identity\)/);
  assert.match(html, /<script src="identity\.js"><\/script>/);
  assert.match(html, /XenonSubmitIdentity\.mount\(document\.getElementById\('identity'\), \{ hub: HUB, lang: lang \}\)/);
});

test('the signed-in page hands the token to the form under the key the form reads, and stays private', () => {
  const page = readFileSync(path.join(DIR, 'signed-in', 'index.html'), 'utf8');
  const key = "'xenon.submit.identity.done'";
  assert.ok(page.includes('DONE_KEY = ' + key) && js.includes('DONE_KEY = ' + key));
  assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(page, /<meta name="referrer" content="no-referrer">/);
  assert.match(page, /history\.replaceState\(null, '', location\.pathname\)/);
  for (const l of ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh']) assert.ok(page.includes(`    ${l}: { ok: [`), l);
  // The form sends nothing until the token is there.
  assert.match(js, /view === 'ok' && token \? secret \+ '\.' \+ token : ''/);
});
