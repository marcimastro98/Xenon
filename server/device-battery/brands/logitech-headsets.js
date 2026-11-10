'use strict';
// Logitech headsets answer in millivolts, on HID++ frames sent to a fixed feature index.
// The voltage curves are HeadsetControl's published estimates; below the last point a
// reading means nothing, so it is dropped.

const { ids, reading, validPercent } = require('./ids');

const LOGITECH = 0x046D;
const HIDPP_LONG = 0x11;
const DEVICE = 0xFF;
const ERROR_FRAME = 0xFF;
const AT_FEATURE = 2;
const STATE_CHARGING = 3;
const FRAME_BYTES = 20;

// [percent, millivolts], from full to empty.
const CURVE_PRO = [[100, 4150], [50, 3830], [30, 3780], [20, 3740], [5, 3670], [0, 3320]];
const CURVE_G535 = [[100, 4175], [50, 3817], [30, 3766], [20, 3730], [5, 3664], [0, 3310]];
const CURVE_G533 = [[100, 4200], [50, 3850], [30, 3790], [20, 3750], [5, 3680], [0, 3330]];
const CURVE_G633 = [[100, 4100], [80, 3950], [60, 3850], [40, 3750], [20, 3650], [10, 3500], [5, 3300], [0, 3150]];

function percentFromCurve(curve, millivolts) {
  if (millivolts >= curve[0][1]) return 100;
  for (let i = 1; i < curve.length; i++) {
    const [low, lowMv] = curve[i];
    if (millivolts < lowMv) continue;
    const [high, highMv] = curve[i - 1];
    return Math.round(low + ((high - low) * (millivolts - lowMv)) / (highMv - lowMv));
  }
  return null;
}

function reader(feature, sub, curve) {
  return async (io) => {
    const isAnswer = (r) => r[0] === HIDPP_LONG && r[1] === DEVICE && (r[AT_FEATURE] === feature || r[AT_FEATURE] === ERROR_FRAME);
    const reply = await io.ask([HIDPP_LONG, DEVICE, feature, sub], isAnswer);
    if (!reply || reply[AT_FEATURE] === ERROR_FRAME) return [];   // the dongle is there, the headset is off
    return reading(percentFromCurve(curve, reply[4] * 256 + reply[5]), reply[6] === STATE_CHARGING);
  };
}

const model = (label, productIds, feature, sub, curve, page = 0xFF43, usage = 0x0202) => ({
  label, products: ids(LOGITECH, productIds), page, usage, size: FRAME_BYTES, read: reader(feature, sub, curve),
});

// ASTRO A50 Gen 5, as HaloBattery (MIT) reads it. The short reply is only an acknowledgement.
const A50_REQUEST = [0x02, 0x0C, 0x03, 0x00, 0x06, 0x0C];
const A50_WAIT_MS = 500;

async function readA50(io) {
  const isAnswer = (r) => r[0] === 0x02 && r[1] === 0x0C && r[2] > 3 && r[4] === 0x06;
  const r = await io.ask(A50_REQUEST, isAnswer, A50_WAIT_MS);
  return r ? reading(validPercent(r[6]), r[8] !== 0) : [];
}

module.exports = [
  model('Logitech G PRO headset', [0x0AA7, 0x0AAA, 0x0ABA, 0x0AFB, 0x0AFC], 0x06, 0x0D, CURVE_PRO),
  model('Logitech G535', [0x0AC4], 0x05, 0x0D, CURVE_G535, 0x000C, 0x0001),
  model('Logitech G533', [0x0A66], 0x07, 0x01, CURVE_G533),
  model('Logitech G headset', [0x0A5C, 0x0A89, 0x0AB5, 0x0AFE, 0x0B1F, 0x0A5B, 0x0A87], 0x08, 0x0A, CURVE_G633),
  { label: 'ASTRO A50', products: ids(LOGITECH, [0x0B1C]), page: 0xFF32, usage: 0x0074, size: 64, read: readA50 },
];
module.exports.percentFromCurve = percentFromCurve;
module.exports.CURVE_PRO = CURVE_PRO;
