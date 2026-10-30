// The creator's status page on the website (docs/submit/status/) and the link
// the submit form hands out (docs/submit/index.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'docs', 'submit', 'status');
const page = createRequire(import.meta.url)(path.join(DIR, 'status.js'));
const html = readFileSync(path.join(DIR, 'index.html'), 'utf8');
const js = readFileSync(path.join(DIR, 'status.js'), 'utf8');
const submit = readFileSync(path.join(ROOT, 'docs', 'submit', 'index.html'), 'utf8');

test('every site language carries every string', () => {
  assert.deepEqual(page.LANGS.slice().sort(), ['en', 'es', 'fr', 'it', 'ja', 'ko', 'zh']);
  const keys = Object.keys(page.STRINGS.en).sort();
  for (const l of page.LANGS) {
    assert.deepEqual(Object.keys(page.STRINGS[l]).sort(), keys, l);
    for (const k of keys) assert.ok(page.STRINGS[l][k].trim(), l + '.' + k);
  }
  for (const s of page.SECTION_KEYS) assert.ok(page.STRINGS.en['sec_' + s], s);
});

test('the fragment must be exactly an id and a token', () => {
  const token = 'A'.repeat(43);
  assert.deepEqual(page.parseHash('#sub_abc123.' + token), { id: 'sub_abc123', token });
  for (const bad of ['', '#', '#sub_abc', '#sub_ABC.' + token, '#sub_abc.' + token + 'x', '#sub_abc.short', '#x/../y']) {
    assert.equal(page.parseHash(bad), null, bad);
  }
});

test('the headline follows the status, and only a reviewer decides an outcome', () => {
  assert.equal(page.statusKey(null), 'bad_link');
  assert.equal(page.statusKey({ status: 'approved' }), 's_approved');
  assert.equal(page.statusKey({ status: 'rejected' }), 's_rejected');
  assert.equal(page.statusKey({ status: 'pending', report: { source: 'audit', outcome: 'fix' } }), 's_pending');
  assert.equal(page.statusKey({ status: 'pending', report: { source: 'review', outcome: 'fix' } }), 's_fix');
  assert.equal(page.statusKey({ status: 'pending', report: { source: 'review', outcome: 'sellable' } }), 's_sellable');
});

test('amounts always name their currency', () => {
  assert.equal(page.money(3), '3.00 USD');
  assert.equal(page.money(0), null);
  assert.equal(page.money('x'), null);
});

test('the page stays private and renders text only', () => {
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.doesNotMatch(html, /googletagmanager|gtag\(|cloudflareinsights|analytics\.js/, 'no analytics on a page whose URL holds a token');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(html, /<!-- xenon:header -->[\s\S]*xh-brand[\s\S]*<!-- \/xenon:header -->/);
});

test('the submit form shows the status link, in every language', () => {
  assert.match(submit, /id="statusLink" hidden/);
  assert.match(submit, /'\/submit\/status\/#' \+ id \+ '\.' \+ token/);
  assert.equal((submit.match(/ok_status:/g) || []).length, 6, 'fr it es ko ja zh (en is the markup)');
  assert.equal((submit.match(/ok_copy:/g) || []).length, 6);
});

test('the supporter code is optional, sent only when typed, and its errors are said in every language', () => {
  assert.match(submit, /<input type="text" id="supporterCode"[^>]*autocomplete="off"/);
  assert.ok(!/id="supporterCode"[^>]*required/.test(submit), 'the field never blocks a submission');
  assert.match(submit, /if \(supporterCode\) fd\.append\('supporterCode', supporterCode\)/);
  assert.match(submit, /err === 'bad_supporter_code'/);
  assert.match(submit, /err === 'supporter_expired'/);
  for (const key of ['f_supporter', 'e_supporter', 'e_supporter_exp']) {
    assert.equal((submit.match(new RegExp('\n      ' + key + ':', 'g')) || []).length, 6, key + ': fr it es ko ja zh');
  }
  // The code is a credential: the page never keeps it.
  assert.ok(!/supporterCode[^\n]*localStorage|localStorage[^\n]*supporterCode/.test(submit));
});

test('design advice shows apart from the verdict, as text, in every language', () => {
  assert.equal((submit.match(/\n      audit_design:/g) || []).length, 6, 'audit_design: fr it es ko ja zh');
  assert.match(submit, /lastAudit\.design/);
  // Advice never feeds the justification gate, which reads the verdict only.
  assert.ok(!/design[^\n]*justifyWrap|justifyWrap[^\n]*design/.test(submit));
  assert.match(submit, /fix\.textContent = String\(f\.fix\)/);
});

test('a pending supporter submission says it is reviewed first', () => {
  assert.match(js, /sub\.priority && sub\.status === 'pending' \? T\('priority'\)/);
});

test('the submit form\'s inline scripts parse', async () => {
  const vm = await import('node:vm');
  // Plain inline JavaScript only: JSON-LD and src= scripts are not code here.
  const scripts = [...submit.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/type="application\/ld\+json"|\ssrc=/.test(m[1] || '')).map((m) => m[2]).filter((s) => s.trim());
  assert.ok(scripts.length > 0);
  for (const source of scripts) new vm.Script(source);
});

test('a similar entry shows what it costs today, never an invented price', () => {
  assert.deepEqual(page.compPrice({ access: 'supporters' }), { key: 'with_pass' });
  assert.deepEqual(page.compPrice({ access: 'item', price: 3 }), { key: 'drop' });
  assert.deepEqual(page.compPrice({ access: 'free', price: 0 }), { key: 'free' });
  assert.deepEqual(page.compPrice({ price: 2.5 }), { text: '2.50 USD' });
});

test("the submit form sends the creator's optional price and explains a bad one", () => {
  assert.match(submit, /id="price"[^>]*inputmode="decimal"/);
  assert.match(submit, /fd\.append\('price', price\)/);
  assert.match(submit, /err === 'bad_price'/);
  for (const k of ['f_price', 'e_price']) assert.equal((submit.match(new RegExp('^ +' + k + ': ', 'gm')) || []).length, 6, k);
});

test('nobody sells yet: the price field and the suggested price stay off screen', () => {
  assert.match(submit, /<label class="f" hidden><span data-t="f_price">/);
  assert.match(submit, /label\.f\[hidden\] \{ display: none; \}/);
  assert.match(js, /var SHOW_PRICE = false;/);
  assert.match(js, /if \(SHOW_PRICE && r\.price\) root\.append\(priceBlock\(r\.price\)\);/);
});

test('the status page says first how much must and should be fixed, tips left out', () => {
  const it = (k) => page.STRINGS.it[k];
  const list = [{ severity: 'fix' }, { severity: 'block' }, { severity: 'tip' }, { severity: 'fix' }];
  assert.deepEqual(page.summaryLines(list, it), [
    { severity: 'block', n: 1, text: 'Da correggere per forza: 1. Finché restano, non può entrare nella Store.' },
    { severity: 'fix', n: 2, text: 'Da correggere: 2. Conviene farlo prima della prossima versione.' },
  ]);
  assert.deepEqual(page.summaryLines([{ severity: 'tip' }], it), []);
  assert.deepEqual(page.summaryLines(undefined, it), []);
  // The summary sits above the list; red and orange are bars, never the text.
  assert.match(js, /summaryLines\(list, T\)[\s\S]*var ul = el\('ul', 'st-list'\)/);
  assert.match(html, /\.st-f\.st-block \{ border-left-color: var\(--danger\); \}/);
  assert.match(html, /\.st-f\.st-fix \{ border-left-color: var\(--warn\); \}/);
});

test('the submit form groups the check by weight under a plain summary, in every language', () => {
  for (const k of ['audit_sum_block', 'audit_sum_warn', 'audit_grp_block', 'audit_grp_warn', 'audit_grp_info']) {
    assert.equal((submit.match(new RegExp('\n      ' + k + ':', 'g')) || []).length, 6, k + ': fr it es ko ja zh');
  }
  assert.match(submit, /auditBox\.appendChild\(groupedFindings\(findings\)\)/);
  // Heaviest first, the summary only for what holds a submission back.
  assert.match(submit, /\['block', 'warn', 'info'\]\.forEach/);
  assert.match(submit, /\['block', 'warn'\]\.forEach/);
  assert.match(submit, /\.finding\.block \{ border-left-color: var\(--danger\); \}/);
  // No shouted badges: the group heading says the weight.
  assert.doesNotMatch(submit, /sev_(block|warn|info)|className = 'sev /);
});
