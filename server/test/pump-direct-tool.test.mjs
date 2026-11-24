// tools/pump-direct/try.mjs, the try of Xenon's own pump screen driver on a real screen: its
// options are bounded, its cards escape their words, and it reaches the screen only through
// lcd-link.js (so only picture parts), refusing while iCUE runs. Nothing here touches a device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs, cardHtml } from '../../tools/pump-direct/try.mjs';

const require = createRequire(import.meta.url);

test('the try takes sane options only', () => {
  assert.deepEqual(parseArgs([]), { fps: 10, seconds: 10, pauses: [2, 4, 8, 15, 30] });
  assert.deepEqual(parseArgs(['--fps', '25', '--seconds', '5', '--pauses', '1,3']), { fps: 25, seconds: 5, pauses: [1, 3] });
  assert.throws(() => parseArgs(['--fps', '200']), /--fps/);
  assert.throws(() => parseArgs(['--seconds', '0']), /--seconds/);
  assert.throws(() => parseArgs(['--pauses', '2,x']), /--pauses/);
  assert.throws(() => parseArgs(['--pauses', '500']), /--pauses/);
});

test('a card is the panel size, its words escaped', () => {
  const html = cardHtml(7, '<b>&');
  assert.match(html, /width:480px;height:480px/);
  assert.match(html, />7</);
  assert.ok(html.includes('&lt;b&gt;&amp;') && !html.includes('<b>&'));
});

test('the try reaches the screen only through the driver, never while iCUE runs', () => {
  const src = readFileSync(new URL('../../tools/pump-direct/try.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('createLcdLink(') && src.includes('link.show('), 'pictures go through lcd-link.js');
  assert.ok(!/\.write\(/.test(src), 'no report written by hand');
  assert.match(src, /createLinkBusy\(\)\(\)/);
  assert.match(src, /if \(busy\.length\) throw/);
  assert.match(src, /await link\.close\(\)/, 'the screen is let go at the end');
});

// tools/pump-direct/live.mjs: Xenon's own drawing for a while on a real pump, through the same parts the
// server uses (direct-start.js realParts), so it steps aside for iCUE exactly as the app does.
test('the live run takes sane options, counts what reached the screen, and uses the app parts', async () => {
  const live = await import('../../tools/pump-direct/live.mjs');
  assert.deepEqual(live.parseArgs([]), { seconds: 60, port: 3030, screen: 'pump' });
  assert.deepEqual(live.parseArgs(['--seconds', '90', '--port', '3031', '--screen', 'pump-2']), { seconds: 90, port: 3031, screen: 'pump-2' });
  assert.throws(() => live.parseArgs(['--seconds', '700']), /--seconds/);
  assert.throws(() => live.parseArgs(['--port', 'x']), /--port/);
  assert.throws(() => live.parseArgs(['--screen', '../x']), /--screen/);
  assert.deepEqual(live.rate([1024, 3072], 1000), { fps: 2, kb: 2 });
  assert.deepEqual(live.rate([], 10000), { fps: 0, kb: 0 });
  const src = readFileSync(new URL('../../tools/pump-direct/live.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('realParts(') && src.includes('createPumpDirect('), 'the same controller and parts as the app');
  assert.ok(!/\.write\(|Stop-Process|taskkill|\.kill\(/.test(src), 'no report by hand, no program closed');
  assert.match(src, /await direct\.stop\(\)/);
});

// tools/pump-direct/linux-rig.mjs reads what Xenon writes to a pretend pump on Linux as the
// screen would (report-stream.mjs): these are its pure parts.
test('the pretend screen puts pictures back together from any chunks, and counts anything else', async () => {
  const { createReportStream, PANEL } = await import('../../tools/pump-direct/report-stream.mjs');
  const Lcd = require('../pump-screen/lcd-corsair.js');
  const jpeg = (n, fill) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, fill), Buffer.from([0xff, 0xd9])]);
  const one = jpeg(2500, 1);
  const two = jpeg(300, 2);
  const command = Buffer.alloc(PANEL.reportBytes);
  command.set([0x03, 0x0b, 0x32, 0x01]);
  const [first, , last] = Lcd.pictureReports(one);
  const bytes = Buffer.concat([...Lcd.pictureReports(one), command, first, last, ...Lcd.pictureReports(two)]);
  const pictures = [];
  let stray = 0;
  const push = createReportStream({ onPicture: (p) => pictures.push(p), onStray: () => { stray += 1; } });
  for (let at = 0; at < bytes.length; at += 700) push(bytes.subarray(at, at + 700));
  assert.deepEqual(pictures.map((p) => p.length), [one.length, two.length]);
  assert.ok(pictures[0].equals(one) && pictures[1].equals(two));
  assert.equal(stray, 2, 'the command, and the part that came out of order');
});

test('the pretend screen reads a picture size, finds a normal user, and looks like a real pump', async () => {
  const { jpegSize, normalUser, PANEL, PUMP_DESCRIPTOR, pumpUevent } = await import('../../tools/pump-direct/report-stream.mjs');
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, ...new Array(9).fill(0)];
  assert.deepEqual(jpegSize(Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9])), { width: 640, height: 480 });
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, ...app0, 0xff, 0xd9])), null);
  assert.equal(jpegSize(Buffer.from('not a picture')), null);

  const passwd = ['root:x:0:0::/root:/bin/bash', 'svc:x:1001:1001::/:/usr/sbin/nologin', 'player:x:1002:1002::/home/player:/bin/bash',
    'other:x:1003:1003::/home/other:/bin/zsh', 'nobody:x:65534:65534::/:/bin/sh'].join('\n');
  assert.deepEqual(normalUser(passwd), { user: 'player', uid: 1002, gid: 1002, home: '/home/player' });
  assert.equal(normalUser(passwd, 'other').uid, 1003);
  assert.equal(normalUser(passwd, 'svc'), null);
  assert.equal(normalUser('root:x:0:0::/root:/bin/bash'), null);

  const { topCollections } = require('../hid/hidraw-format.js');
  assert.deepEqual(topCollections(PUMP_DESCRIPTOR).map((c) => c.outputLength), [PANEL.reportBytes], 'what lcd-link.js looks for');
  assert.match(pumpUevent(), /HID_ID=0003:00001B1C:00000C4E/);
});
