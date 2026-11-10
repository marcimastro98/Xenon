// A shared Deck profile's links carry no one's chat, number or token
// (js/share-link-privacy.js through js/preset-share.js, on export and on import).
// A community submission of 10 Nov 2026 had a key opening its author's own
// Telegram chat (web.telegram.org/a/#<id>), bound for the public catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { shareableLink } = require('../js/share-link-privacy.js');
const PresetShare = require('../js/preset-share.js');
const DeckModel = require('../js/deck-model.js');
const DeckActions = require('../js/deck-actions.js');
const here = path.dirname(fileURLToPath(import.meta.url));

test('a link into a chat becomes the chat app itself', () => {
  const cases = {
    'https://web.telegram.org/a/#123456789': 'https://web.telegram.org/a/',
    'https://web.telegram.org/k/#@someone': 'https://web.telegram.org/k/',
    'web.telegram.org/#123': 'https://web.telegram.org/',
    'https://t.me/someone': 'https://web.telegram.org/',
    'https://wa.me/15550100': 'https://web.whatsapp.com/',
    'https://api.whatsapp.com/send?phone=15550100&text=hi': 'https://web.whatsapp.com/',
    'https://chat.whatsapp.com/AbCdEf123': 'https://web.whatsapp.com/',
    'https://discord.com/channels/@me/100000000000000001': 'https://discord.com/channels/@me',
    'https://discord.com/channels/200000000000000002/300000000000000003': 'https://discord.com/channels/@me',
    'https://m.me/someone': 'https://www.messenger.com/',
    'https://www.messenger.com/t/100000000000001': 'https://www.messenger.com/',
    'https://signal.me/#p/+15550100': 'https://signal.org/',
    'https://www.instagram.com/direct/t/1234567890/': 'https://www.instagram.com/direct/inbox/',
  };
  for (const [from, to] of Object.entries(cases)) assert.equal(shareableLink(from), to, from);
});

test('an ordinary link stays exactly as it was', () => {
  for (const url of ['https://www.youtube.com/', 'https://web.whatsapp.com/', 'youtube.com/watch?v=abc', 'https://discord.gg/abc123',
    'https://discord.com/invite/abc123', 'https://www.instagram.com/xenon/', 'http://127.0.0.1:3030/', 'https://example.com/#/dashboard?tab=2',
    'https://www.google.com/search?q=weather', '', 'not a url at all']) {
    assert.equal(shareableLink(url), url, url);
  }
});

test('secrets and addresses in any link go, the rest of it stays', () => {
  assert.equal(shareableLink('https://me:hunter2@example.com/feed'), 'https://example.com/feed');
  assert.equal(shareableLink('https://example.com/feed?api_key=abc&page=2'), 'https://example.com/feed?page=2');
  assert.equal(shareableLink('https://example.com/x?Access-Token=1&Email=a%40example.com&q=ok'), 'https://example.com/x?q=ok');
  assert.equal(shareableLink('mailto:someone@example.com'), '');
  assert.equal(shareableLink('tel:+15550100'), '');
  assert.equal(shareableLink('tg://resolve?domain=someone'), '');
});

test('a shared Deck key keeps a working link with nobody in it, on export and import alike', () => {
  const key = (title, url) => ({ kind: 'action', title, icon: { type: 'emoji', value: '★' }, triggers: { tap: { type: 'openUrl', url } } });
  const profile = { name: 'DESK', root: { pages: [{ keys: [key('Telegram', 'https://web.telegram.org/a/#43374525'), key('YouTube', 'https://www.youtube.com/')] }] } };
  const deps = { model: DeckModel, actions: DeckActions };
  const once = PresetShare.sanitizeDeckProfile(profile, deps);
  const urls = (p) => p.root.pages[0].keys.filter(Boolean).map((k) => DeckActions.triggerSteps(k.triggers.tap)[0].action.url);
  assert.deepEqual(urls(once), ['https://web.telegram.org/a/', 'https://www.youtube.com/']);
  assert.deepEqual(urls(PresetShare.sanitizeDeckProfile(once, deps)), urls(once), 'cleaning twice changes nothing');
});

test('the app loads the cleaner before the share code', () => {
  const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
  const a = html.indexOf('<script src="js/share-link-privacy.js"></script>');
  assert.ok(a > 0 && a < html.indexOf('<script src="js/preset-share.js"></script>'));
});
