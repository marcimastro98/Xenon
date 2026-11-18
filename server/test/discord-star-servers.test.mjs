// Starring a whole server in the Discord tile's Channels tab. Asked on Discord: someone who
// joins every channel of one server stars them one at a time, and "Only starred" then needs
// each of them starred again after a new channel appears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';
import { appStrings } from './i18n-source.mjs';

const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SRC = read('../js/discord-widget/channel-list.js');

function node(tag, cls, text) {
  return {
    tag, className: cls || '', textContent: text || '', kids: [], attrs: {}, listeners: {}, dataset: {}, title: '',
    classList: { toggle() {}, add() {} },
    get childElementCount() { return this.kids.length; },
    append(...k) { this.kids.push(...k); }, appendChild(k) { this.kids.push(k); },
    replaceChildren(...k) { this.kids = k.flatMap((x) => (x.frag ? x.kids : [x])); },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(n, f) { this.listeners[n] = f; },
    querySelector() { return null; },
  };
}

function world({ favOnly = false, favs = [], guilds = [] } = {}) {
  const saved = [];
  const folded = [];
  const ctx = {
    hubSettings: { discordFavChannels: favs, discordCollapsedGuilds: [], discordFavOnly: favOnly, discordFavGuilds: guilds },
    saveTileSetting: (patch) => { saved.push(patch); ctx.hubSettings = { ...ctx.hubSettings, ...patch }; return Promise.resolve(true); },
    document: { createDocumentFragment: () => Object.assign(node('frag'), { frag: true }) },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('../js/discord-widget/lists.js'), ctx);
  ctx.DiscordWidgetTabs = { t: (_k, d) => d };
  ctx.DiscordWidgetMemberState = { syncMemberStates() {} };
  ctx.DiscordWidgetIcons = { ICONS: { star: '', caret: '' } };
  vm.runInContext(SRC, ctx);
  const channels = [
    { id: '1', name: 'Lobby', guild: 'Alpha', guildId: '10' },
    { id: '2', name: 'Squad', guild: 'Alpha', guildId: '10' },
    { id: '3', name: 'Music', guild: 'Bravo', guildId: '20' },
    { id: '4', name: 'Raid', guild: 'Bravo', guildId: '20' },
  ];
  const { paintChannels } = ctx.DiscordWidgetChannelList({
    el: node, discordState: { connected: true, channels, voice: null, roster: new Map() }, runAction() {},
    toggleFav() {}, toggleGuild: (id) => folded.push(id), toggleAllGuilds() {}, memberChip: () => node('i'), memberShape: () => '',
  });
  const list = node('div', 'dc-chan-list');
  const mount = { querySelector: () => list };
  paintChannels(mount);
  const text = (n) => [n.textContent, ...n.kids.map(text)].join(' ');
  const rows = () => list.kids.filter((k) => k.className === 'dc-guild-row');
  return { list, saved, folded, rows, all: () => text(list) };
}

test('a starred server comes first, under the starred channels', () => {
  const w = world({ guilds: ['20'] });
  const all = w.all();
  assert.ok(all.indexOf('Music') < all.indexOf('Lobby'), 'Bravo moves above Alpha');
  assert.equal(w.rows().length, 2, 'both servers keep their heading');
});

test('"Only starred" keeps the starred server and all its channels', () => {
  const w = world({ favOnly: true, guilds: ['20'] });
  assert.match(w.all(), /Music/);
  assert.match(w.all(), /Raid/);
  assert.doesNotMatch(w.all(), /Lobby|Squad/);
  assert.match(w.all(), /Show all/, 'a starred server alone offers the switch');
});

test('a starred server and a starred channel both stay under "Only starred"', () => {
  const w = world({ favOnly: true, favs: ['1'], guilds: ['20'] });
  assert.match(w.all(), /Lobby/);
  assert.match(w.all(), /Music/);
  assert.doesNotMatch(w.all(), /Squad/);
});

test('the star is its own target: it saves the server and does not fold it', () => {
  const w = world();
  const bravo = w.rows()[1];
  const [heading, star] = bravo.kids;
  assert.equal(heading.className, 'dc-guild');
  assert.match(star.className, /dc-guild-fav/);
  assert.equal(star.attrs['aria-pressed'], 'false');
  let stopped = false;
  star.listeners.click({ stopPropagation: () => { stopped = true; } });
  assert.ok(stopped);
  assert.equal(JSON.stringify(w.saved), '[{"discordFavGuilds":["20"]}]');
  assert.deepEqual(w.folded, [], 'starring never folds the server');
  assert.match(w.all(), /Only starred/, 'the tapped tile repaints at once');
  // Tapping again takes it off: the reset path, as for a channel.
  const again = w.rows()[0].kids[1];
  assert.equal(again.attrs['aria-pressed'], 'true');
  again.listeners.click({ stopPropagation() {} });
  assert.equal(JSON.stringify(w.saved[1]), '{"discordFavGuilds":[]}');
});

test('the repaint signature notices a starred server', () => {
  const sig = SRC.slice(SRC.indexOf('const sig = !linked'));
  assert.match(sig.slice(0, sig.indexOf('if (list.dataset.dcSig')), /favGuildIds\(\)\.join\(','\)/);
});

test('the choice is kept on both sides and from a widget on the screen', () => {
  const { normalizeHubApp } = require('../settings/normalize-app.js');
  assert.deepEqual(normalizeHubApp({ discordFavGuilds: ['123456789012345678', 'name', 7] }).discordFavGuilds, ['123456789012345678']);
  assert.deepEqual(normalizeHubApp({}).discordFavGuilds, []);
  assert.deepEqual([...require('../settings/defaults-app.js').HUB_DEFAULTS_APP.discordFavGuilds], []);
  assert.match(read('../js/settings/normalize-settings.js'), /discordFavGuilds: normalizeSnowflakeList\(value\.discordFavGuilds\)/);
  assert.equal(require('../grid/tile-settings.js').FIELDS.discordFavGuilds, 'list');
});

test('both labels are in every language', () => {
  const strings = appStrings();
  for (const lang of ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh']) {
    assert.ok(strings[lang].discord_w_star_server, lang);
    assert.ok(strings[lang].discord_w_unstar_server, lang);
  }
});
