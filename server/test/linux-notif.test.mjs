'use strict';
// linux-notif.js — reading desktop notifications off the session bus.
//
// The risk here is silent misattribution: the Notify signature puts app_name,
// app_icon, summary and body in a fixed order with no labels, so counting the
// wrong strings would put someone's message text in the app-name field and
// still look like a working feature. Every test below is about that.
//
// The fixture is written to dbus-monitor's documented output. Capture the real
// thing on a Linux desktop with:
//   dbus-monitor --session "interface='org.freedesktop.Notifications',member='Notify'"
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ln = require('../linux-notif.js');

const NOTIFY = `method call time=1784500000.123456 sender=:1.84 -> destination=:1.12 serial=421 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify
   string "Thunderbird"
   uint32 0
   string "mail-unread"
   string "Marcello"
   string "Ci vediamo alle 18"
   array [
      string "default"
      string "Open"
   ]
   array [
      dict entry(
         string "urgency"
         variant             byte 1
      )
   ]
   int32 -1`;

const CAPABILITIES = `method call time=1784500001.000000 sender=:1.90 -> destination=:1.12 serial=2 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=GetCapabilities
   string "should-not-be-read"
   string "nor-this"
   string "nor-this-either"
   string "nor-this-one"`;

const CLOSED = `signal time=1784500002.000000 sender=:1.12 -> destination=:1.84 serial=99 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=NotificationClosed
   uint32 7
   uint32 2`;

test('parseNotifyBlock: the four positional strings land in the right fields', () => {
  const item = ln.parseNotifyBlock(NOTIFY);
  assert.equal(item.app, 'Thunderbird');
  assert.equal(item.title, 'Marcello');           // summary, NOT the icon name
  assert.equal(item.body, 'Ci vediamo alle 18');
  // The icon name is the second string and must never be read as the title.
  assert.notEqual(item.title, 'mail-unread');
  // Linux has no AUMID, and the icon is a theme name rather than image data.
  assert.equal(item.aumid, '');
  assert.equal(item.icon, null);
  assert.ok(item.at > 0);
});

test('parseNotifyBlock: strings inside the actions array are never counted', () => {
  // "default" and "Open" come after body. Reading a fifth string would start
  // shifting every field the moment an app adds an action.
  const item = ln.parseNotifyBlock(NOTIFY);
  assert.notEqual(item.body, 'default');
  assert.notEqual(item.app, 'default');
});

test('parseNotifyBlock: an escaped quote in the text does not truncate it', () => {
  const block = `method call member=Notify
   string "Chat"
   uint32 0
   string ""
   string "He said \\"hi\\""
   string "line one"`;
  const item = ln.parseNotifyBlock(block);
  assert.equal(item.app, 'Chat');
  assert.equal(item.title, 'He said "hi"');
  assert.equal(item.body, 'line one');
});

test('parseNotifyBlock: too few strings, or no text at all, is not an item', () => {
  assert.equal(ln.parseNotifyBlock('method call member=Notify\n   string "OnlyOne"'), null);
  assert.equal(ln.parseNotifyBlock(''), null);
  assert.equal(ln.parseNotifyBlock(null), null);
  // Four empty strings: an app that notifies with nothing readable.
  const empty = 'method call member=Notify\n' + '   string ""\n'.repeat(4);
  assert.equal(ln.parseNotifyBlock(empty), null);
});

test('isNotifyCall: only a Notify method call is a notification', () => {
  assert.equal(ln.isNotifyCall(NOTIFY), true);
  // A capabilities query carries four strings and would parse cleanly — the
  // member check is the only thing keeping it out of the feed.
  assert.equal(ln.isNotifyCall(CAPABILITIES), false);
  assert.ok(ln.parseNotifyBlock(CAPABILITIES), 'the guard matters because this DOES parse');
  assert.equal(ln.isNotifyCall(CLOSED), false);
  assert.equal(ln.isNotifyCall(''), false);
});

test('splitBlocks: a stream of messages splits on headers, not on blank lines', () => {
  const stream = [NOTIFY, CLOSED, CAPABILITIES].join('\n');
  const blocks = ln.splitBlocks(stream);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[0].includes('Thunderbird'));
  assert.equal(ln.splitBlocks('').length, 0);
  // Output before the first header is not a block.
  assert.equal(ln.splitBlocks('some preamble\nmore preamble').length, 0);
});

test('splitBlocks: a body containing a blank line stays inside its own block', () => {
  const block = `method call member=Notify
   string "App"
   uint32 0
   string ""
   string "Summary"
   string "first

third"`;
  const blocks = ln.splitBlocks(block + '\n' + CLOSED);
  assert.equal(blocks.length, 2, 'a blank line inside a value must not end the block');
  assert.ok(blocks[0].includes('third'));
});

test('unescapeDbus: the escapes dbus-monitor emits are undone, others left alone', () => {
  assert.equal(ln.unescapeDbus('a\\nb'), 'a\nb');
  assert.equal(ln.unescapeDbus('a\\tb'), 'a\tb');
  assert.equal(ln.unescapeDbus('a\\"b'), 'a"b');
  assert.equal(ln.unescapeDbus('C:\\\\path'), 'C:\\path');
  assert.equal(ln.unescapeDbus('plain'), 'plain');
});

test('MONITOR_ARGS: the match rule narrows the bus to the one member we want', () => {
  assert.ok(ln.MONITOR_ARGS.includes('--session'));
  const rule = ln.MONITOR_ARGS.find((a) => a.includes('member='));
  assert.ok(/interface='org\.freedesktop\.Notifications'/.test(rule));
  assert.ok(/member='Notify'/.test(rule));
});

test('the whole path: a raw stream becomes exactly the items worth showing', () => {
  // What winnotif.js's Linux reader does, end to end.
  const stream = [CAPABILITIES, NOTIFY, CLOSED].join('\n');
  const items = ln.splitBlocks(stream)
    .filter((b) => ln.isNotifyCall(b))
    .map((b) => ln.parseNotifyBlock(b))
    .filter(Boolean);
  assert.equal(items.length, 1);
  assert.equal(items[0].app, 'Thunderbird');
  assert.equal(items[0].body, 'Ci vediamo alle 18');
});
