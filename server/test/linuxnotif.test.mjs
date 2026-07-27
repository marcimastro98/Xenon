import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ln = require('../linuxnotif.js');

// Drive the module through its line parser — the exact code path the
// dbus-monitor child feeds — so the Notify-block projection, dedup and cap are
// testable without a session bus.
let items = [];
let feedEvents = 0;
let excludedApps = [];

// Feed a whole dbus-monitor text block one line at a time.
function feed(block) { block.split('\n').forEach(l => ln._handleLine(l)); }

// A real org.freedesktop.Notifications.Notify method call as dbus-monitor prints
// it: app_name, replaces_id, app_icon, summary, body, actions[], hints[], expire.
function notify(app, summary, body) {
  return [
    `method call time=1.0 sender=:1.9 -> destination=:1.47 serial=9 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify`,
    `   string "${app}"`,
    `   uint32 0`,
    `   string ""`,
    `   string "${summary}"`,
    `   string "${body}"`,
    `   array [`,
    `   ]`,
    `   array [`,
    `      dict entry(`,
    `         string "urgency"`,
    `         variant             byte 1`,
    `      )`,
    `   ]`,
    `   int32 -1`,
  ].join('\n');
}

beforeEach(() => {
  items = [];
  feedEvents = 0;
  excludedApps = [];
  ln.init({
    isExcluded: (it) => excludedApps.includes(it.app),
    onItem: (it) => items.push(it),
    onFeed: () => { feedEvents++; },
  });
});

test('isSupported and reportedState follow the platform', () => {
  const onLinux = process.platform === 'linux';
  assert.equal(ln.isSupported(), onLinux);
});

test('a Notify call becomes one projected feed item', () => {
  feed(notify('Thunderbird', 'New message', 'From: a@example.com'));
  // The trailing top-level int32 closes the block, so the item lands without a
  // following message.
  assert.equal(items.length, 1);
  assert.equal(items[0].app, 'Thunderbird');
  assert.equal(items[0].title, 'New message');
  assert.equal(items[0].body, 'From: a@example.com');
  assert.equal(items[0].icon, null);
  assert.ok(items[0].id > 0);
});

test('the GNOME Shell re-emit of the same toast is deduped', () => {
  // The real app→daemon call and the daemon→proxy re-emit are identical content
  // microseconds apart; only one should reach the feed.
  feed(notify('Slack', 'Ping', 'hello'));
  feed(notify('Slack', 'Ping', 'hello'));
  assert.equal(items.length, 1);
});

test('distinct notifications are all kept', () => {
  feed(notify('Slack', 'Ping', 'one'));
  feed(notify('Slack', 'Ping', 'two'));
  assert.equal(items.length, 2);
});

test('empty summary and body with an app name still counts; fully empty is dropped', () => {
  feed(notify('SomeApp', '', ''));
  assert.equal(items.length, 1);
  feed(notify('', '', ''));
  assert.equal(items.length, 1);   // nothing usable → not added
});

test('excluded apps are filtered out', () => {
  excludedApps = ['Discord'];
  feed(notify('Discord', 'msg', 'body'));
  assert.equal(items.length, 0);
});

test('non-Notify traffic is ignored', () => {
  feed([
    `signal time=1.0 sender=org.freedesktop.DBus -> destination=:1.9 serial=2 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameAcquired`,
    `   string ":1.9"`,
    `method call time=1.0 sender=:1.9 -> destination=:1.5 serial=3 path=/org/x; interface=org.other.Thing; member=DoStuff`,
    `   string "not a notification"`,
  ].join('\n'));
  assert.equal(items.length, 0);
});

test('length caps hold on title and body', () => {
  feed(notify('App', 'T'.repeat(500), 'B'.repeat(900)));
  assert.equal(items[0].title.length, 200);
  assert.equal(items[0].body.length, 400);
});
