// The pure parts of linux-rig.mjs: what Xenon writes to a pump screen, read back as the screen
// would read it, and the pretend screen's own description. Tests: server/test/pump-direct-tool.test.mjs.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Lcd = require('../../server/pump-screen/lcd-corsair.js');

export const PANEL = Lcd.panelOf(0x1b1c, 0x0c4e);
const HEADER_BYTES = 8;

// A CORSAIR iCUE LINK pump screen's HID description, as the kernel shows it in report_descriptor:
// report 1 in (63 bytes), report 2 out (1023 bytes, the pictures), report 3 a feature.
export const PUMP_DESCRIPTOR = Buffer.from([
  0x06, 0x42, 0xff, 0x09, 0x01, 0xa1, 0x01,
  0x85, 0x01, 0x75, 0x08, 0x95, 0x3f, 0x09, 0x02, 0x81, 0x02,
  0x85, 0x02, 0x96, 0xff, 0x03, 0x09, 0x03, 0x91, 0x02,
  0x85, 0x03, 0x95, 0x10, 0x09, 0x04, 0xb1, 0x02,
  0xc0,
]);

export const pumpUevent = () => 'DRIVER=hid-generic\nHID_ID=0003:00001B1C:00000C4E\nHID_NAME=Pretend pump screen\n';

/**
 * Puts the pictures back together from the bytes written to the screen's node, in any chunks.
 * Every report must be a picture part (lcd-corsair.js isPictureReport) in order; anything else
 * goes to onStray and starts the next picture over.
 * @param {{ onPicture: (jpeg: Buffer) => void, onStray: (report: Buffer) => void }} o
 */
export function createReportStream({ onPicture, onStray }) {
  let pending = Buffer.alloc(0);
  let parts = [];
  return function push(chunk) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= PANEL.reportBytes) {
      const report = Buffer.from(pending.subarray(0, PANEL.reportBytes));
      pending = pending.subarray(PANEL.reportBytes);
      if (!Lcd.isPictureReport(report) || report.readUInt16LE(4) !== parts.length) {
        onStray(report);
        parts = [];
        continue;
      }
      parts.push(report.subarray(HEADER_BYTES, HEADER_BYTES + report.readUInt16LE(6)));
      if (report[3] === 1) {
        onPicture(Buffer.concat(parts));
        parts = [];
      }
    }
  };
}

/** The size a JPEG says in its frame header, or null when it is not a whole JPEG. @param {Buffer} jpeg */
export function jpegSize(jpeg) {
  if (!Lcd.isJpeg(jpeg)) return null;
  for (let i = 2; i + 9 < jpeg.length;) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { width: jpeg.readUInt16BE(i + 7), height: jpeg.readUInt16BE(i + 5) };
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return null;
}

/** The first person's account in /etc/passwd (uid 1000 up, a login shell): Chromium refuses root. */
export function normalUser(passwd, name = '') {
  for (const line of String(passwd).split('\n')) {
    const [user, , uid, gid, , home, shell] = line.split(':');
    const n = Number(uid);
    if (!user || !(n >= 1000 && n < 60000) || /nologin|false/.test(shell || '')) continue;
    if (!name || name === user) return { user, uid: n, gid: Number(gid), home };
  }
  return null;
}
