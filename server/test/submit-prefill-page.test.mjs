// "Send a corrected version" on the website: docs/submit/prefill.js reads the
// status link out of /submit/#from=<id>.<token>, asks the hub for what that
// submission sent, and the submit form applies it and names the submission it
// replaces. The status page links there for a submission to fix or a rejected one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'docs', 'submit');
const js = readFileSync(path.join(DIR, 'prefill.js'), 'utf8');
const html = readFileSync(path.join(DIR, 'index.html'), 'utf8');
const status = readFileSync(path.join(DIR, 'status', 'status.js'), 'utf8');
const TOKEN = 'A'.repeat(43);
const HUB = 'https://hub.test';

// prefill.js with a fake address bar and a fake hub. `answers` maps a path to
// (body) => { status, json?, blob? }.
function load(hash, answers = {}) {
  const calls = [];
  const loc = { hash, pathname: '/submit/', search: '' };
  const win = {};
  const fetch = async (url, init) => {
    const p = url.slice(HUB.length);
    const body = JSON.parse(init.body);
    calls.push({ p, body, init });
    const a = answers[p] ? answers[p](body) : { status: 404 };
    return {
      ok: a.status >= 200 && a.status < 300, status: a.status,
      json: async () => a.json, blob: async () => a.blob,
    };
  };
  class File { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts.type; } }
  vm.runInNewContext(js, {
    window: win, location: loc, fetch, File, JSON, Math, Number, String, RegExp,
    history: { replaceState(_s, _t, url) { loc.hash = ''; loc.replaced = url; } },
  });
  return { api: win.XenonSubmitPrefill, calls, loc };
}

const FIELDS = { kind: 'bundle', name: 'Quiet Fields', tags: 'calm green', accent: '#00f8ff' };

test('every site language carries every line, in plain words', () => {
  const start = js.indexOf('var WORDS = {');
  const end = js.indexOf('\n  };', start) + 5;
  const words = vm.runInNewContext(js.slice(start, end) + ' WORDS;', {});
  assert.deepEqual(Object.keys(words).sort(), ['en', 'es', 'fr', 'it', 'ja', 'ko', 'zh']);
  const keys = Object.keys(words.en).sort();
  for (const [l, d] of Object.entries(words)) {
    assert.deepEqual(Object.keys(d).sort(), keys, l);
    for (const k of keys) assert.ok(d[k].trim() && !d[k].includes('—'), l + '.' + k);
  }
});

test('only an exact #from=<id>.<token> is read', async () => {
  const { api, calls } = load('');
  assert.deepEqual({ ...api.parseFrom('#from=sub_abc123.' + TOKEN) }, { id: 'sub_abc123', token: TOKEN });
  for (const bad of ['', '#sub_abc.' + TOKEN, '#from=sub_ABC.' + TOKEN, '#from=sub_abc.short', '#from=sub_abc.' + TOKEN + '&x=1']) {
    assert.equal(api.parseFrom(bad), null, bad);
  }
  assert.equal(await api.load(HUB), null);
  assert.equal(calls.length, 0, 'an ordinary visit asks nothing');
});

test('a waiting submission comes back whole and the token leaves the address bar', async () => {
  const { api, calls, loc } = load('#from=sub_abc.' + TOKEN, {
    '/submission/prefill': () => ({ status: 200, json: { ok: true, status: 'pending', fields: FIELDS, code: 'eyJ4fQ', shots: 2 } }),
    '/submission/prefill/shot': (b) => ({ status: 200, blob: { type: b.n === 1 ? 'image/webp' : 'image/png' } }),
  });
  const got = await api.load(HUB);
  assert.equal(loc.hash, '', 'the token is taken off the address bar');
  assert.equal(loc.replaced, '/submit/');
  assert.deepEqual({ ...got.ref }, { id: 'sub_abc', token: TOKEN });
  assert.equal(got.notice, 'full');
  assert.equal(got.code, 'eyJ4fQ');
  assert.deepEqual([...got.files.map((f) => f.name)], ['shot-1.webp', 'shot-2.png']);
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.deepEqual(calls.slice(1).map((c) => c.body.n), [1, 2]);
});

test('a rejected one brings the words back; a shot of an odd type is left out', async () => {
  const { api } = load('#from=sub_abc.' + TOKEN, {
    '/submission/prefill': () => ({ status: 200, json: { ok: true, status: 'rejected', fields: FIELDS, code: '', shots: 1 } }),
    '/submission/prefill/shot': () => ({ status: 200, blob: { type: 'text/html' } }),
  });
  const got = await api.load(HUB);
  assert.equal(got.notice, 'words');
  assert.equal(got.files.length, 0);
  assert.equal(got.fields.name, 'Quiet Fields');
});

test('a dead link or a hub that does not answer says so and names nothing', async () => {
  const gone = await load('#from=sub_abc.' + TOKEN).api.load(HUB);
  assert.deepEqual({ ...gone }, { ref: null, notice: 'gone' });
  const busy = await load('#from=sub_abc.' + TOKEN, { '/submission/prefill': () => ({ status: 429, json: { ok: false } }) }).api.load(HUB);
  assert.deepEqual({ ...busy }, { ref: null, notice: 'failed' });
});

test('the form loads it, applies it, and names the submission it replaces', () => {
  assert.match(html, /<script src="prefill\.js"><\/script>/);
  assert.match(html, /id="prefillCard" hidden/);
  assert.match(html, /XenonSubmitPrefill\.load\(HUB\)\.then\(applyPrefill\)/);
  assert.match(html, /fd\.append\('replaces', prefillRef\.id\); fd\.append\('replacesToken', prefillRef\.token\)/);
  assert.match(html, /XenonSubmitTags\.set\(f\.tags\)/);
});

test('the status page links the filled form for a submission to fix or a rejected one', () => {
  assert.match(status, /key === 's_fix' \|\| key === 's_rejected'/);
  assert.match(status, /'\/submit\/#from=' \+ current\.id \+ '\.' \+ current\.token/);
});
