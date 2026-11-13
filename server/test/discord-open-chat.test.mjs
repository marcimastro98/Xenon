// "Reply" on a mirrored Discord DM or mention, and "Open Discord", on every OS.
//
// Asked for on Discord (Oct 2026): "I wanted to be able to respond to the
// notifications I receive from DMs". Xenon cannot send the message: Discord's
// local connection has no command for it, and using the account token would be
// a self bot, which Discord bans. So the button brings Discord forward on the PC
// with that conversation open. While building it, the "Open Discord" button
// turned out to be PowerShell only: on macOS and Linux it did nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import { appStrings } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const L = require('../discord-launch.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── Launching, per platform ─────────────────────────────────────────────────

test('Windows opens the discord:// link through the shell, as it always did', () => {
  const [plan, ...rest] = L.launchPlans('win32');
  assert.equal(rest.length, 0);
  assert.equal(plan.cmd, 'powershell.exe');
  assert.ok(plan.args.some((a) => a.includes("FileName='discord://'")));
});

test('macOS opens the app bundle, then the link for a renamed one', () => {
  const plans = L.launchPlans('darwin');
  assert.deepEqual(plans.map((p) => [p.cmd, ...p.args]), [
    ['/usr/bin/open', '-a', 'Discord'],
    ['/usr/bin/open', 'discord://'],
  ]);
});

test('Linux tries the binary, Flatpak and Snap before xdg-open', () => {
  // xdg-open goes last: the .deb registers no discord: handler, and a desktop
  // xdg-open does not recognise can hand the link to the web browser.
  const plans = L.launchPlans('linux');
  assert.deepEqual(plans.map((p) => p.cmd), ['discord', 'flatpak', 'snap', 'xdg-open']);
  assert.deepEqual(plans[1].args, ['run', 'com.discordapp.Discord']);
  assert.equal(plans[0].direct, true, 'the binary IS Discord: started means done');
});

test('every launch is a fixed argv: nothing from the request reaches it', () => {
  for (const platform of ['win32', 'darwin', 'linux', 'freebsd']) {
    for (const plan of L.launchPlans(platform)) {
      assert.equal(typeof plan.cmd, 'string');
      assert.ok(Array.isArray(plan.args));
      assert.ok(plan.args.every((a) => !/\d{5,}/.test(a)), 'no channel id in a command line');
    }
  }
});

test('the first launch that works wins, and a full miss says so', async () => {
  const tried = [];
  const run = (ok) => async (plan) => { tried.push(plan.cmd); return { ok: ok.includes(plan.cmd) }; };
  assert.deepEqual(await L.launchWith(L.launchPlans('linux'), run(['flatpak', 'snap'])), { ok: true });
  assert.deepEqual(tried, ['discord', 'flatpak'], 'stops at the first success');
  assert.deepEqual(await L.launchWith(L.launchPlans('linux'), run([])), { ok: false, error: 'launch_failed' });
});

// ── Opening one conversation ────────────────────────────────────────────────

const CH = '123456789012345678';
const noWait = { sleep: async () => {}, retries: 4 };

test('a bad channel id is refused before anything runs', async () => {
  let ran = false;
  const deps = { launch: async () => { ran = true; return { ok: true }; }, select: async () => { ran = true; return { ok: true }; } };
  for (const bad of ['', 'abc', '12', '1; rm -rf /', null, 42]) {
    assert.deepEqual(await L.openConversation(bad, deps, noWait), { ok: false, error: 'bad_channel' });
  }
  assert.equal(ran, false);
});

test('Discord is brought forward first, then the chat is selected', async () => {
  const order = [];
  const r = await L.openConversation(CH, {
    launch: async () => { order.push('launch'); return { ok: true }; },
    select: async (id) => { order.push('select:' + id); return { ok: true }; },
  }, noWait);
  assert.deepEqual(r, { ok: true, selected: true });
  assert.deepEqual(order, ['launch', 'select:' + CH]);
});

test('a Discord that is still starting is waited for, a few times', async () => {
  let calls = 0;
  const r = await L.openConversation(CH, {
    launch: async () => ({ ok: true }),
    select: async () => (++calls < 3 ? { ok: false, error: 'discord_not_running' } : { ok: true }),
  }, noWait);
  assert.deepEqual(r, { ok: true, selected: true });
  assert.equal(calls, 3);
});

test('an unlinked account is not waited for, and Discord still comes up', async () => {
  let calls = 0;
  const r = await L.openConversation(CH, {
    launch: async () => ({ ok: true }),
    select: async () => { calls++; return { ok: false, error: 'not_connected' }; },
  }, noWait);
  assert.deepEqual(r, { ok: true, selected: false, error: 'not_connected' });
  assert.equal(calls, 1);
});

test('the retries are bounded', async () => {
  let calls = 0;
  await L.openConversation(CH, {
    launch: async () => ({ ok: true }),
    select: async () => { calls++; return { ok: false, error: 'discord_closed' }; },
  }, noWait);
  assert.equal(calls, 5, 'the first try and four retries');
});

test('nothing at all happening is an error, not a quiet success', async () => {
  const r = await L.openConversation(CH, {
    launch: async () => ({ ok: false }),
    select: async () => { throw new Error('discord_not_running'); },
  }, { ...noWait, retries: 0 });
  assert.equal(r.ok, false);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('the RPC client selects the channel with a checked id, and never throws', async () => {
  const rpc = read('../discord-rpc.js');
  const at = rpc.indexOf('async function openTextChannel(');
  assert.ok(at > 0);
  const body = rpc.slice(at, rpc.indexOf('\n  }\n', at));
  assert.match(body, /if \(!isSnowflake\(id\)\) return \{ ok: false, error: 'bad_channel' \}/);
  assert.match(body, /command\('SELECT_TEXT_CHANNEL', \{ channel_id: id \}\)/);
  assert.match(body, /catch \(e\)/);
  assert.match(rpc, /return \{[^}]*\bopenTextChannel\b/, 'exposed on the provider');
});

test('both routes go through the cross-platform launcher', () => {
  const server = engineSource();
  const launch = server.slice(server.indexOf("reqPath === '/stream/discord/launch'"), server.indexOf("reqPath === '/stream/discord/open-chat'"));
  assert.match(launch, /discordLaunch\.launchDiscord\(\)/);
  assert.doesNotMatch(launch, /powershell\.exe/, 'a PowerShell-only launch does nothing on macOS and Linux');
  const open = server.slice(server.indexOf("reqPath === '/stream/discord/open-chat'"), server.indexOf('// ── Spotify integration'));
  assert.match(open, /readBody\(req, 4096\)/, 'a small body, capped');
  assert.match(open, /openDiscordChat\(body && body\.channelId\)/);
  assert.match(server, /const openDiscordChat = [\s\S]{0,200}select: \(id\) => discordRpc\.openTextChannel\(id\)/);
});

test('the widget offers Reply only where it can act, and says what happened', () => {
  const w = read('../js/discord-widget.js');
  const at = w.indexOf('function replyButton(');
  const body = w.slice(at, w.indexOf('\n  }\n', at));
  assert.match(body, /if \(!n\.channelId\) return null;/);
  assert.match(body, /RemoteSurface\.isRemote\(\)\) return null;/, 'a paired phone answers in its own Discord app');
  assert.match(body, /ev\.stopPropagation\(\)/, 'the row tap still reveals hidden text');
  assert.match(w, /api\('\/stream\/discord\/open-chat'/);
  assert.match(w, /discord_w_notif_reply_partial/);
  assert.match(w, /discord_w_notif_reply_failed/);
});

test('every string of the button is translated in every language', () => {
  const keys = ['discord_w_notif_reply', 'discord_w_notif_reply_title', 'discord_w_notif_reply_partial', 'discord_w_notif_reply_failed'];
  for (const lang of ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh']) {
    for (const key of keys) assert.ok(appStrings()[lang][key], lang + ' is missing ' + key);
  }
});

test('the Reply button stays readable on a light theme', () => {
  // The dark theme's pale blurple (#b7c0ff) is a smudge on a light panel.
  const light = read('../styles/themes-light.css');
  assert.match(light, /:root\[data-appearance="light"\] \.dc-notif-reply \{ color: #4752c4; \}|\.dc-notif-reply \{ color: #4752c4; \}/);
  assert.match(light, /:root\[data-appearance="light"\] \.dc-notif-title,/);
});

test('an SDK widget can open a chat, and only as a hidden, granted action', async () => {
  const { actionSpec, validateAction } = require('../js/deck-actions.js');
  const reg = require('../actions/registry.js');
  const sdk = require('../sdk-widgets.js');
  // A Deck key has no message to take the channel id from.
  assert.equal(actionSpec('discordOpenChat').hidden, true);
  assert.ok(sdk.SDK_ACTION_CATEGORIES.discord.includes('discordOpenChat'));
  assert.match(read('../js/custom-widget.js'), /discord: \[[^\]]*'discordOpenChat'/);
  assert.equal(validateAction({ type: 'discordOpenChat', channel: '9'.repeat(80) }).channel.length, 25);

  const run = (result) => reg.createRegistry({ discordOpenChat: async () => result })
    .run({ type: 'discordOpenChat', channel: '42' });
  assert.deepEqual(await run({ ok: true, selected: true }), { ok: true });
  // Discord came up, the chat did not: the widget must say so.
  assert.deepEqual(await run({ ok: true, selected: false }), { ok: false, error: 'chat_not_opened' });
  assert.deepEqual(await run({ ok: false, error: 'bad_channel' }), { ok: false, error: 'bad_channel' });
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'discordOpenChat', channel: '42' }),
    { ok: false, error: 'discord_unavailable' });
});

test('a paired phone is refused the chat, and a widget is told it is on one', () => {
  // It would open Discord on the PC, out of sight of whoever tapped.
  assert.doesNotMatch(read('../remote-actions.js'), /discordOpenChat/);
  assert.match(read('../js/custom-widget.js'), /remote: !!\(window\.RemoteSurface/);
});

test('the SDK docs teach the chat action to Bit and to widget authors', () => {
  const doc = read('../../docs/WIDGET_SDK.md');
  assert.match(doc, /### 5d-bis\. Replying to a message: `discordOpenChat`/);
  assert.match(doc, /remote: false/);
  assert.match(doc, /items:\[\{ id, at, title, body, icon, channelId, messageType \}\]/);
  assert.match(read('../../docs/create/index.html'), /<code>discordOpenChat<\/code>/);
});
