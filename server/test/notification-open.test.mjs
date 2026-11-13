// Tap a notification, get its app (server/notification-open/). A user asked that
// a notification on the side screen open the app it came from. Pinned here: the
// window is found from the AUMID / display name / desktop entry without false
// hits, only an app in the Start menu's Apps folder (or an installed .desktop
// entry) is ever started, the caller names a feed id and nothing else, and the
// Deck / Bit / widget row reach it through the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { matchWindow, aumidWords, isLaunchableAumid, isDesktopEntryId } = require('../notification-open/match.js');
const { createNotificationOpener, platformDeps, findItem } = require('../notification-open/index.js');
const { parseStartApps, createStartAppIds, launchAumid } = require('../notification-open/start-apps.js');
const { parseNotifyBlock } = require('../linux-notif.js');
const { createCapabilities, aiFunctions } = require('../capabilities/index.js');
const { validateAction } = require('../js/deck-actions.js');
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const WINDOWS = [
  { id: '101', app: 'Code', title: 'server.js' },
  { id: '102', app: 'Discord', title: 'general' },
  { id: '103', app: 'chrome', title: 'Inbox' },
  { id: '104', app: 'ApplicationFrameHost', title: 'Calculator' },
  { id: '105', app: 'WhatsApp', title: 'WhatsApp' },
  { id: '106', app: 'TelegramDesktop', title: 'Telegram' },
];

test('AUMID words: the app, without vendor, packaging or publisher hash', () => {
  assert.deepEqual(aumidWords('com.squirrel.Discord.Discord'), ['discord', 'discord']);
  assert.deepEqual(aumidWords('5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App'), ['5319275a', 'whatsappdesktop']);
  assert.deepEqual(aumidWords('Microsoft.Windows.Explorer'), ['explorer']);
});

test('the window of the app that posted the notification is found', () => {
  assert.equal(matchWindow(WINDOWS, { app: 'Discord', aumid: 'com.squirrel.Discord.Discord' }).id, '102');
  assert.equal(matchWindow(WINDOWS, { app: 'Google Chrome', aumid: 'Chrome' }).id, '103');
  assert.equal(matchWindow(WINDOWS, { app: 'WhatsApp', aumid: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' }).id, '105');
  assert.equal(matchWindow(WINDOWS, { app: 'Telegram', desktopEntry: 'org.telegram.desktop' }).id, '106');
});

test('no false hit: an unrelated app, a host process or a short name is not a match', () => {
  assert.equal(matchWindow(WINDOWS, { app: 'Mail', aumid: 'microsoft.windowscommunicationsapps_8wekyb3d8bbwe!microsoft.windowslive.mail' }), null);
  assert.equal(matchWindow(WINDOWS, { app: 'Calculator', aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }), null, 'never the frame host');
  assert.equal(matchWindow([{ id: '1', app: 'go' }], { app: 'Go' }), null, 'a two-letter process says nothing');
  assert.equal(matchWindow(WINDOWS, {}), null);
  assert.equal(matchWindow([{ id: 'abc', app: 'Discord' }], { app: 'Discord' }), null, 'only a numeric window id');
});

test('only an AUMID or desktop id of a plain shape is accepted', () => {
  for (const ok of ['Chrome', 'com.squirrel.Discord.Discord', '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App',
    '{6D809377-6AF0-444B-8957-A3773F02200E}\\Mozilla Firefox\\firefox.exe']) assert.equal(isLaunchableAumid(ok), true, ok);
  for (const bad of ['', 'a b', 'x"y', 'x,y', '..\\x', 'C:\\Windows\\cmd.exe', 'shell:x', 'a/b', '{6D809377-6AF0-444B-8957-A3773F02200E}\\..\\x', 'x'.repeat(201)]) {
    assert.equal(isLaunchableAumid(bad), false, bad);
  }
  assert.equal(isDesktopEntryId('org.telegram.desktop'), true);
  for (const bad of ['', '../x', '/usr/share/x', 'a b', '.hidden']) assert.equal(isDesktopEntryId(bad), false, bad);
});

test('the feed id picks the notification; anything else is none', () => {
  const feed = [{ id: 7, app: 'A' }, { id: 5, app: 'B' }];
  assert.equal(findItem(feed, 'latest').id, 7);
  assert.equal(findItem(feed, undefined).id, 7);
  assert.equal(findItem(feed, '5').id, 5);
  for (const bad of ['9', '0', '-5', '5.5', 'x']) assert.equal(findItem(feed, bad), null, bad);
  assert.equal(findItem([], 'latest'), null);
});

function fakeWindows(over) {
  const calls = { focus: [], aumid: [], desktop: [] };
  const deps = {
    feed: () => [{ id: 3, app: 'Discord', aumid: 'com.squirrel.Discord.Discord' }, { id: 2, app: 'Slack', aumid: 'com.squirrel.slack.slack' }],
    listWindows: async () => ({ windows: WINDOWS }),
    focusWindow: async (id) => { calls.focus.push(id); return { ok: true }; },
    startAppIds: async () => new Set(['com.squirrel.slack.slack']),
    launchAumid: async (a) => { calls.aumid.push(a); },
    ...over,
  };
  return { calls, opener: createNotificationOpener(deps) };
}

test('an open app comes to the front; a closed one starts from the Apps folder', async () => {
  const { calls, opener } = fakeWindows();
  assert.deepEqual(await opener.open('latest'), { ok: true, how: 'focused', app: 'Discord' });
  assert.deepEqual(calls.focus, ['102']);
  assert.deepEqual(await opener.open('2'), { ok: true, how: 'opened', app: 'Slack' });
  assert.deepEqual(calls.aumid, ['com.squirrel.slack.slack']);
});

test('an AUMID the Apps folder does not list is never handed to explorer', async () => {
  const { calls, opener } = fakeWindows({
    feed: () => [{ id: 1, app: 'Edge page', aumid: 'MSEdge.Something' }],
    listWindows: async () => ({ windows: [] }),
  });
  assert.deepEqual(await opener.open('latest'), { ok: false, error: 'not_launchable', app: 'Edge page' });
  assert.deepEqual(calls.aumid, []);
});

test('a failed focus falls back to starting; a failed start is said', async () => {
  const { opener } = fakeWindows({
    feed: () => [{ id: 1, app: 'Slack', aumid: 'com.squirrel.slack.slack' }],
    listWindows: async () => ({ windows: [{ id: '9', app: 'slack' }] }),
    focusWindow: async () => ({ ok: false }),
    launchAumid: async () => { throw new Error('ENOENT'); },
  });
  assert.deepEqual(await opener.open('latest'), { ok: false, error: 'launch_failed', app: 'Slack' });
  const none = createNotificationOpener({ feed: () => [] });
  assert.deepEqual(await none.open('latest'), { ok: false, error: 'no_notification' });
});

test('Linux: the desktop entry the notification named is started with gio', async () => {
  const launched = [];
  const opener = createNotificationOpener(platformDeps({
    platform: 'linux',
    feed: () => [{ id: 4, app: 'Telegram', aumid: '', desktopEntry: 'org.telegram.desktop' }],
    listWindows: async () => ({ windows: [] }),
    focusWindow: async () => ({ ok: true }),
    getInstalledApps: async () => [
      { name: 'Files', kind: 'desktop', target: '/usr/share/applications/org.gnome.Nautilus.desktop' },
      { name: 'Telegram Desktop', kind: 'desktop', target: '/usr/share/applications/org.telegram.desktop.desktop' },
    ],
    launchLinuxApp: async (p) => { launched.push(p); },
  }));
  assert.deepEqual(await opener.open('latest'), { ok: true, how: 'opened', app: 'Telegram' });
  assert.deepEqual(launched, ['/usr/share/applications/org.telegram.desktop.desktop']);
  assert.equal(opener.available(), true);
  assert.equal(createNotificationOpener(platformDeps({ platform: 'darwin' })).available(), false, 'macOS reads no notifications');
});

test('Linux: the desktop-entry hint is read from the Notify call, and only a plain id', () => {
  const block = (entry) => [
    'method call time=1 sender=:1.2 -> destination=:1.3 serial=5 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify',
    '   string "Telegram"', '   uint32 0', '   string ""', '   string "Example Contact"', '   string "Hello"',
    '   array [', '   ]', '   array [', '      dict entry(', '         string "desktop-entry"',
    '         variant             string "' + entry + '"', '      )', '   ]', '   int32 -1',
  ].join('\n');
  assert.equal(parseNotifyBlock(block('org.telegram.desktop')).desktopEntry, 'org.telegram.desktop');
  assert.equal(parseNotifyBlock(block('../../etc/x')).desktopEntry, '');
  assert.equal(parseNotifyBlock(block('a b')).desktopEntry, '');
});

test('Windows: the Start apps list, read once and kept, and explorer exit 1 is not a failure', async () => {
  assert.deepEqual(parseStartApps('{"Name":"Slack","AppID":"com.squirrel.slack.slack"}'), [{ name: 'Slack', id: 'com.squirrel.slack.slack' }]);
  assert.deepEqual(parseStartApps('not json'), []);
  let reads = 0;
  const ids = createStartAppIds(async () => { reads++; return [{ id: 'A!B' }]; });
  assert.ok((await ids()).has('A!B'));
  await ids();
  assert.equal(reads, 1);
  const exe = (code) => (_file, _args, _opts, cb) => { cb(code == null ? null : Object.assign(new Error('x'), { code })); };
  await launchAumid(exe(1), 'A!B');
  await assert.rejects(launchAumid(exe('ENOENT'), 'A!B'));
  const seen = [];
  await launchAumid((file, args, _opts, cb) => { seen.push([file, args]); cb(null); }, 'A!B');
  assert.deepEqual(seen, [['explorer.exe', ['shell:AppsFolder\\A!B']]], 'one argv entry, no shell');
});

test('the registry: only a feed id travels, the newest by default', async () => {
  const asked = [];
  const caps = createCapabilities({ notificationOpen: { available: () => true, open: async (w) => { asked.push(w); return { ok: true, how: 'focused', app: 'A' }; } } });
  assert.equal(caps.probes().notificationOpen, true);
  assert.equal(createCapabilities({}).probes().notificationOpen, false);
  await caps.run(validateAction({ type: 'notificationOpen' }));
  await caps.run(validateAction({ type: 'notificationOpen', id: '12' }));
  assert.deepEqual(asked, ['latest', '12']);
  assert.equal((await caps.run({ type: 'notificationOpen', id: 'C:\\x.exe' })).error, 'no_notification');
  assert.ok(aiFunctions({ notificationOpen: true }).some((f) => f.name === 'open_notification_app'));
});

test('the widget row and the pop-up open it, on the PC only, with no inline handlers', () => {
  const page = read('../js/notification-open.js');
  assert.match(page, /window\.__xenonRemote/);
  assert.match(page, /JSON\.stringify\(\{ type: 'notificationOpen', id: String\(item\.id\) \}\)/);
  const widget = read('../js/notifications-widget.js');
  assert.match(widget, /window\.NotificationOpen\.bind\(txt, n\)/);
  assert.match(widget, /window\.NotificationOpen\.toastAction\(item\)/);
  assert.match(read('../index.html'), /<script src="js\/notification-open\.js"><\/script>\s*<script src="js\/notifications-widget\.js"><\/script>/);
  assert.match(read('../js/layer-tiles.js'), /\['js\/notification-open\.js', 'js\/notifications-widget\.js'\]/);
  assert.match(engineSource(), /notificationOpen: createNotificationOpener\(notificationOpenDeps\(\{/);
});
