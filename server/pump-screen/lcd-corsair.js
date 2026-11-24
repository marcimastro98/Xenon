'use strict';
// The CORSAIR iCUE LINK pump screen (1B1C:0C4E) spoken to directly, as iCUE does it. Facts from our
// own USB capture of iCUE 5 drawing on a real one (23 Nov 2026): one HID interface; a picture is a
// JPEG of the whole panel (480x480) sent as 1024-byte output reports, report id 0x02, command 0x05:
//   02 05 00 <1 on the last part, else 0> <part number, LE16> <bytes of JPEG in it, LE16> <up to 1016 bytes>
// iCUE sent 25 pictures a second and the screen answered nothing. The only other thing iCUE said in
// 40 s was a 32-byte feature report (id 3, command 0x19) every ~27 s, whose meaning we do not know:
// it is never sent from here, and the screen showed our pictures without it (iCUE closed, 10 a
// second, then held each ~31 s). Nothing else can be built in this file: no brightness, turning,
// picture store or firmware command, so nothing a screen keeps after Xenon stops.

const REPORT_BYTES = 1024;
const HEADER_BYTES = 8;
const PART_BYTES = REPORT_BYTES - HEADER_BYTES;
const PICTURE_REPORT = 0x02;
const PICTURE_COMMAND = 0x05;
// iCUE's pictures were 50-55 KB; a face is far smaller than this, a runaway encoder is not.
const MAX_JPEG_BYTES = 256 * 1024;

// The screens this file speaks to: only ids seen in a capture of our own.
const PANELS = Object.freeze([
  Object.freeze({
    vendorId: 0x1b1c, productId: 0x0c4e, model: 'iCUE LINK AIO LCD', width: 480, height: 480, shape: 'round', reportBytes: REPORT_BYTES,
    // The programs that draw on it too: Xenon waits while one runs (direct-apps.js).
    holders: Object.freeze({ win32: Object.freeze(['icue']), linux: Object.freeze(['openlinkhub']) }),
  }),
]);

const panelOf = (vendorId, productId) => PANELS.find((p) => p.vendorId === vendorId && p.productId === productId) || null;

const isJpeg = (b) => Buffer.isBuffer(b) && b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

/**
 * One picture as the reports that carry it, in order.
 * @param {Buffer} jpeg a whole baseline JPEG at the panel's size
 * @returns {Buffer[]}
 */
function pictureReports(jpeg) {
  if (!isJpeg(jpeg)) throw new Error('not a JPEG picture');
  if (jpeg.length > MAX_JPEG_BYTES) throw new Error('the picture is too large for the pump screen');
  const count = Math.ceil(jpeg.length / PART_BYTES);
  const out = [];
  for (let i = 0; i < count; i++) {
    const part = jpeg.subarray(i * PART_BYTES, (i + 1) * PART_BYTES);
    const report = Buffer.alloc(REPORT_BYTES);
    report[0] = PICTURE_REPORT;
    report[1] = PICTURE_COMMAND;
    report[3] = i === count - 1 ? 1 : 0;
    report.writeUInt16LE(i, 4);
    report.writeUInt16LE(part.length, 6);
    part.copy(report, HEADER_BYTES);
    out.push(report);
  }
  return out;
}

/**
 * Whether a report is one this file may send: a picture part and nothing else. The writer checks
 * every report with it before it leaves, so a bug elsewhere can never reach the screen as a command.
 * @param {Buffer} report
 */
function isPictureReport(report) {
  if (!Buffer.isBuffer(report) || report.length !== REPORT_BYTES) return false;
  if (report[0] !== PICTURE_REPORT || report[1] !== PICTURE_COMMAND || report[2] !== 0 || report[3] > 1) return false;
  const len = report.readUInt16LE(6);
  return len > 0 && len <= PART_BYTES;
}

module.exports = { PANELS, panelOf, pictureReports, isPictureReport, isJpeg, REPORT_BYTES, PART_BYTES, MAX_JPEG_BYTES };
