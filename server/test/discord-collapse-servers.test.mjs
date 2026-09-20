// Folding a Discord server away in the widget's Channels tab.
//
// Asked for on Discord: "It would be nice to be able to collapse the Discord
// servers underneath the Discord Channels feature so your not forever
// scrolling", with three parts — a per-server toggle, a collapse/expand all,
// and for the state to stick "on future uses".
//
// The drawing is exercised in a browser; what these tests hold is the part that
// rots silently: the setting exists in BOTH normalizers (the server keeps its
// own copy of the field list, and a key added to one and not the other is
// dropped on the next save), the guild id actually reaches the widget from the
// RPC layer, and the SDK's copy of the channel list carries it too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const WIDGET = read('../js/discord-widget.js');
const SERVER = read('../server.js');
const SETTINGS = read('../js/settings.js');
const RPC = read('../discord-rpc.js');
const CUSTOM = read('../js/custom-widget.js');
const CSS = read('../components/DiscordWidget/DiscordWidget.css');
const I18N = read('../js/i18n.js');
const SDK_DOC = read('../../docs/WIDGET_SDK.md');
const CHANGELOG = read('../../CHANGELOG.md');
const FEATURES = read('../../FEATURES.md');

// ── the setting has to exist twice ─────────────────────────────────────────
test('discordCollapsedGuilds is in both normalizers and both defaults', () => {
  // server.js keeps its own copy of the settings field list. A key added to
  // js/settings.js alone is normalized away on the next save, and the symptom
  // is a setting that "does not stick" with nothing in the log.
  for (const [name, src, arg] of [['server.js', SERVER, 'source'], ['js/settings.js', SETTINGS, 'value']]) {
    assert.match(src, /discordCollapsedGuilds: Object\.freeze\(\[\]\),/, name + ' default');
    assert.match(src, new RegExp('discordCollapsedGuilds: normalizeSnowflakeList\\(' + arg + '\\.discordCollapsedGuilds\\)'),
      name + ' normalizer');
  }
});

test('it is stored as guild ids, so it survives a rename', () => {
  // normalizeSnowflakeList only lets digits through — a guild NAME could never
  // be stored here even by accident.
  assert.match(WIDGET, /hubSettings\.discordCollapsedGuilds/);
  assert.match(WIDGET, /function isCollapsed\(guildId\)/);
});

test('the state is saved to the server, not just to this tab', () => {
  const save = WIDGET.slice(WIDGET.indexOf('function saveCollapsed'));
  const body = save.slice(0, save.indexOf('function toggleGuild'));
  assert.match(body, /normalizeSettings\(\{ \.\.\.hubSettings, discordCollapsedGuilds: next \}\)/);
  assert.match(body, /saveHubSettings\(\{ server: true \}\)/, 'it has to outlive the tab');
  assert.match(body, /renderWidgets\(\)/);
});

// ── the id has to get there ────────────────────────────────────────────────
test('the RPC layer sends a guild id with every channel', () => {
  const enum_ = RPC.slice(RPC.indexOf('async function enumVoiceChannels'));
  assert.match(enum_.slice(0, enum_.indexOf('async function listVoiceChannels')),
    /guildId: String\(guild\.id \|\| ''\)/);
  // …and the roster pass must not drop it on the way through.
  const roster = RPC.slice(RPC.indexOf('async function voiceRoster'));
  const matches = roster.slice(0, 1400).match(/guildId: vc\.guildId/g) || [];
  assert.equal(matches.length, 2, 'both the filled and the failed branch carry it');
});

test('an SDK widget on discordChannels gets the guild id too', () => {
  const loader = CUSTOM.slice(CUSTOM.indexOf('discordChannels: Object.freeze({'));
  assert.match(loader.slice(0, 1600), /guildId: String\(c\.guildId \|\| ''\)/,
    'the SDK rebuilds the channel objects by hand — a new field is dropped unless it is added here');
  assert.match(SDK_DOC, /`discordChannels` — `\{ ok, channels:\[\{ id, name, guild, guildId, members:\[\] \}\] \}`/);
});

// ── grouping ───────────────────────────────────────────────────────────────
test('grouping is keyed by id, so two servers sharing a name stay apart', () => {
  const fn = WIDGET.slice(WIDGET.indexOf('function groupByGuild'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.match(body, /const key = id \|\| \('name:' \+ name\);/);
  assert.match(body, /groups\.set\(key, \{ id, name, channels: \[\] \}\)/);
});

test('a server with no id is drawn, and drawn open', () => {
  // An older engine's payload has no guildId. It cannot be remembered, so it
  // must not be collapsible either — but it still has to appear.
  const render = WIDGET.slice(WIDGET.indexOf('groups.forEach((g) => {'));
  const body = render.slice(0, render.indexOf('list.replaceChildren'));
  assert.match(body, /if \(!g\.id\) \{/);
  assert.match(body, /dc-guild--plain/);
  assert.match(body, /if \(!isCollapsed\(g\.id\)\) g\.channels\.forEach\(channelRow\);/);
});

// ── the two controls ───────────────────────────────────────────────────────
test('one button does collapse-all and expand-all', () => {
  const fn = WIDGET.slice(WIDGET.indexOf('function toggleAllGuilds'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  // Anything open → close everything; nothing open → open everything.
  assert.match(body, /const anyOpen = known\.some\(id => !isCollapsed\(id\)\)/);
  assert.match(body, /if \(!anyOpen\) \{ saveCollapsed\(collapsedIds\(\)\.filter\(id => !known\.includes\(id\)\)\); return; \}/);
  // Only from two servers up — with one it is the header's own caret.
  assert.match(WIDGET, /if \(ids\.length > 1\) \{/);
});

test('favourites never folds', () => {
  const render = WIDGET.slice(WIDGET.indexOf('const { pinned, rest } = splitFavourites'));
  const body = render.slice(0, render.indexOf('list.replaceChildren'));
  // The pinned heading stays a plain div with no toggle on it.
  assert.match(body, /el\('div', 'dc-guild dc-guild--fav', t\('discord_w_favourites'/);
  assert.doesNotMatch(body.slice(0, body.indexOf('const ids =')), /toggleGuild/);
});

test('a collapse repaints — the signature notices it', () => {
  // paintChannels skips a rebuild when nothing observable changed, and it runs
  // on every 6s roster tick. Without the collapsed set in the signature the tap
  // would do nothing until a member happened to move.
  const sig = WIDGET.slice(WIDGET.indexOf('const sig = !linked'));
  assert.match(sig.slice(0, sig.indexOf('if (list.dataset.dcSig')), /collapsedIds\(\)\.join\(','\)/);
});

test('the whole heading is the target', () => {
  // A caret you have to hit exactly is a caret you miss on a touchscreen.
  const header = WIDGET.slice(WIDGET.indexOf('const guildHeader ='));
  const body = header.slice(0, header.indexOf('const { pinned, rest }'));
  assert.match(body, /el\('button', 'dc-guild'\)/);
  assert.match(body, /h\.addEventListener\('click', \(\) => toggleGuild\(g\.id\)\)/);
  assert.match(body, /h\.setAttribute\('aria-expanded'/);
  assert.match(body, /dc-guild-count/, 'a shut server still says how much is inside it');
});

// ── the layout trap this file's neighbours already fell into ───────────────
test('the heading keeps its ellipsis after becoming a flex row', () => {
  // .dc-guild carried overflow:hidden with the ellipsis on the element itself,
  // which only works while it is a block. As a flex row the ellipsis has to sit
  // on the child that can shrink, or a long server name pushes the count out of
  // the tile instead of truncating.
  const btn = CSS.slice(CSS.indexOf('button.dc-guild {'));
  assert.match(btn.slice(0, btn.indexOf('}') + 1), /overflow: visible/);
  const name = CSS.slice(CSS.indexOf('.dc-guild-name {'));
  const block = name.slice(0, name.indexOf('}') + 1);
  assert.match(block, /min-width: 0/);
  assert.match(block, /text-overflow: ellipsis/);
});

test('the caret is the state, in both directions', () => {
  assert.match(CSS, /button\.dc-guild\.is-collapsed \.dc-guild-caret,\s*\n\.dc-guild-all-btn\.is-collapsed \.dc-guild-caret \{ transform: rotate\(-90deg\); \}/);
});

// ── wording ────────────────────────────────────────────────────────────────
test('all four strings are in every locale', () => {
  const langs = (I18N.match(/["']?discord_w_favourites["']?\s*:/g) || []).length;
  assert.ok(langs >= 11, 'the anchor key should be in every locale');
  for (const key of ['discord_w_collapse_server', 'discord_w_expand_server', 'discord_w_collapse_all', 'discord_w_expand_all']) {
    assert.equal((I18N.match(new RegExp('["\']?' + key + '["\']?\\s*:', 'g')) || []).length, langs, key);
  }
});

test('it is written down', () => {
  // The whole file, not the [Unreleased] section: entries move into a version
  // section when a release is cut, and pinning the section turned this into a
  // test that broke on the release rather than on the thing it is guarding.
  // (It had already rotted silently — the headings gained a `v` and a date, so
  // the old slice matched nothing and read the entire file.)
  assert.match(CHANGELOG, /collapse the Discord servers/);
  assert.match(FEATURES, /Collapse the servers you never join/);
});
