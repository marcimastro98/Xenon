// "Only starred" in the Discord tile's Channels tab. Asked on Discord: the list
// shows every voice channel of every server, and a small tile only needs the few
// channels someone actually joins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';

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

function world({ favOnly, favs = ['2'] }) {
  const saved = [];
  const ctx = {
    hubSettings: { discordFavChannels: favs, discordCollapsedGuilds: [], discordFavOnly: favOnly },
    saveTileSetting: (patch) => { saved.push(patch); ctx.hubSettings = { ...ctx.hubSettings, ...patch }; return Promise.resolve(true); },
    document: { createDocumentFragment: () => Object.assign(node('frag'), { frag: true }) },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['lists.js']) vm.runInContext(read('../js/discord-widget/' + f), ctx);
  ctx.DiscordWidgetTabs = { t: (_k, d) => d };
  ctx.DiscordWidgetMemberState = { syncMemberStates() {} };
  ctx.DiscordWidgetIcons = { ICONS: { star: '', caret: '' } };
  vm.runInContext(SRC, ctx);
  const channels = [
    { id: '1', name: 'Lobby', guild: 'A', guildId: '10' },
    { id: '2', name: 'Squad', guild: 'A', guildId: '10' },
    { id: '3', name: 'Music', guild: 'B', guildId: '20' },
  ];
  const { paintChannels } = ctx.DiscordWidgetChannelList({
    el: node, discordState: { connected: true, channels, voice: null, roster: new Map() }, runAction() {},
    toggleFav() {}, toggleGuild() {}, toggleAllGuilds() {}, memberChip: () => node('i'), memberShape: () => '',
  });
  const list = node('div', 'dc-chan-list');
  const mount = { querySelector: () => list };
  paintChannels(mount);
  const text = (n) => [n.textContent, ...n.kids.map(text)].join(' ');
  return { list, saved, all: () => text(list), paintChannels, mount };
}

test('with "Only starred" on, the tab lists the starred channels and a way back', () => {
  const w = world({ favOnly: true });
  assert.match(w.all(), /Squad/);
  assert.doesNotMatch(w.all(), /Lobby|Music/, 'the other servers stay out');
  assert.match(w.all(), /Show all/);
  assert.doesNotMatch(w.all(), /Collapse all/);
});

test('off, everything is listed and the switch saves the choice for the tile', async () => {
  const w = world({ favOnly: false });
  assert.match(w.all(), /Lobby/);
  assert.match(w.all(), /Music/);
  const bar = w.list.kids.find((k) => k.className === 'dc-guild-all');
  const sw = bar.kids.find((k) => k.className.includes('dc-fav-only'));
  assert.equal(sw.attrs['aria-pressed'], 'false');
  sw.listeners.click();
  assert.equal(JSON.stringify(w.saved), '[{"discordFavOnly":true}]');
  assert.match(w.all(), /Show all/, 'the tapped tile shows the result at once');
});

test('nothing starred: no switch, the whole list as before', () => {
  const w = world({ favOnly: true, favs: [] });
  assert.match(w.all(), /Lobby/);
  assert.doesNotMatch(w.all(), /Only starred|Show all/);
});

test('the choice survives a save on both sides and from a widget on the screen', () => {
  const { normalizeHubApp } = require('../settings/normalize-app.js');
  assert.equal(normalizeHubApp({ discordFavOnly: true }).discordFavOnly, true);
  assert.equal(normalizeHubApp({ discordFavOnly: 'yes' }).discordFavOnly, false);
  assert.equal(normalizeHubApp({}).discordFavOnly, false);
  assert.match(read('../js/settings/normalize-settings.js'), /discordFavOnly: value\.discordFavOnly === true/);
  assert.equal(require('../grid/tile-settings.js').FIELDS.discordFavOnly, 'bool');
});
