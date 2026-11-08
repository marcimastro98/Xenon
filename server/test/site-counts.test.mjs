// The live numbers beside the site's marks (docs/counts.js): what counts as a download,
// where the number lands, and what a failure leaves behind. Runs the real file on a
// small stand-in for the page, nothing leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const DOCS = new URL('../../docs/', import.meta.url);
const source = await readFile(new URL('counts.js', DOCS), 'utf8');

function element(kind) {
  const link = { title: '' };
  return { kind, link, textContent: '', removed: false, closest: () => link, remove() { this.removed = true; } };
}

// One page load: the elements found, what the two APIs answer, what the session keeps.
async function load({ lang = 'en', releases, invite, kept = {} } = {}) {
  const found = [element('dl'), element('dc')];
  const calls = [];
  const answer = (value) => ({ ok: value !== null, json: async () => value });
  const sandbox = {
    document: {
      documentElement: { lang },
      querySelectorAll: (selector) => found.filter((el) => selector.includes(`"${el.kind}"`) && !el.removed),
    },
    sessionStorage: {
      getItem: (key) => kept[key] ?? null,
      setItem: (key, value) => { kept[key] = value; },
    },
    fetch: async (url) => {
      calls.push(url);
      return answer(url.includes('github') ? releases : invite);
    },
    MutationObserver: class { observe() {} },
    Intl,
    JSON,
    Promise,
    String,
    Array,
  };
  vm.runInNewContext(source, sandbox);
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
  return { dl: found[0], dc: found[1], calls, kept };
}

const release = (...assets) => ({ assets: assets.map(([name, download_count]) => ({ name, download_count })) });

test('only installers count: the updater\'s stamped files and signatures do not', async () => {
  const { dl } = await load({
    releases: [
      release(['Xenon-Setup-x64.exe', 100], ['Xenon-macOS-universal.dmg', 20], ['Xenon_5.0.0_x64-setup.exe', 900], ['Xenon-Setup-x64.exe.sig', 900]),
      { draft: true, assets: [{ name: 'Xenon-Setup-x64.exe', download_count: 500 }] },
      release(['Xenon_1.0.0_setup.exe', 7], ['notes.txt', 50]),
    ],
    invite: { approximate_member_count: 278 },
  });
  assert.equal(dl.textContent, '127');
});

test('the number lands beside its mark and the link says what it is, in the page\'s language', async () => {
  const { dl, dc } = await load({
    lang: 'it',
    releases: [release(['Xenon-Setup-x64.exe', 3434])],
    invite: { approximate_member_count: 278 },
  });
  assert.equal(dl.textContent, '3.434');
  assert.equal(dl.link.title, '3.434 download su GitHub');
  assert.equal(dc.link.title, '278 persone su Discord');
});

test('the number in the bar uses no class a page style also uses', async () => {
  const bar = await readFile(new URL('../../tools/site-chrome.mjs', import.meta.url), 'utf8');
  const guide = await readFile(new URL('guide.css', DOCS), 'utf8');
  const [, classes] = bar.match(/class="([^"]*)" data-count="dl"/);
  for (const name of classes.split(' ')) assert.doesNotMatch(guide, new RegExp(`\.${name}\b`), name);
});

test('a failure leaves the bare mark, never a zero', async () => {
  const { dl, dc } = await load({ releases: null, invite: null });
  assert.equal(dl.removed, true);
  assert.equal(dc.removed, true);
  assert.equal(dl.link.title, '');
});

test('a session asks each API once', async () => {
  const kept = {};
  const first = await load({ releases: [release(['Xenon-Setup-x64.exe', 5])], invite: { approximate_member_count: 2 }, kept });
  assert.equal(first.calls.length, 2);
  const second = await load({ kept });
  assert.equal(second.calls.length, 0);
  assert.equal(second.dl.textContent, '5');
});

test('the download number sits on the GitHub mark, on the home and in the shared bar', async () => {
  const home = await readFile(new URL('index.html', DOCS), 'utf8');
  assert.match(home, /<a class="mk" id="p-dl" href="https:\/\/github\.com\/marcimastro98\/Xenon"[\s\S]*?data-count="dl"[\s\S]*?<\/a>/);
  assert.match(home, /<script src="\/counts\.js" defer><\/script>/);
  const page = await readFile(new URL('faq.html', DOCS), 'utf8');
  assert.match(page, /<a class="xh-mk gh"[^>]*>[\s\S]*?data-count="dl"[\s\S]*?<\/a>/);
  assert.match(await readFile(new URL('chrome.js', DOCS), 'utf8'), /'\/counts\.js'/);
});
