'use strict';
// Rongyuan 2.4 GHz receivers, behind Akko, MonsGeek, Attack Shark and other brands. The
// receiver keeps the last charge of its keyboard and mouse, so asking it wakes neither.
// The status command and the receiver list are the ones BatteryTray (MIT) documents.

const { reading } = require('./ids');

const WAIT_MS = 20;
const RETRY_MS = 100;
const ATTEMPTS = 3;
const STATUS_REQUEST = [0x00, 0xF7];
const KEYBOARD = { level: 2, offline: 4 };
const MOUSE = { level: 3, offline: 5 };
const REPLY_BYTES = 7;
const FEATURE_BYTES = 65;   // 64 and the report id: hidraw gives no size, and a short report can be refused

const RECEIVERS = [
  0x0DB0197E, 0x0DB08E9A, 0x145F0376, 0x145F038D, 0x14A5C045, 0x25AA2008,
  0x25AA4008, 0x25AA4018, 0x31514011, 0x31514014, 0x31514017, 0x31514021,
  0x31514027, 0x3151402D, 0x31514038, 0x31515006, 0x31515007, 0x31515008,
  0x31515020, 0x31515026, 0x3151502B, 0x31515031, 0x31515037, 0x31515038,
  0x3151503D, 0x3151503F, 0x31515040, 0x31515042, 0x31515045, 0x3151504B,
  0x3151504E, 0x31515050, 0x31515052, 0x31515055, 0x3151505A, 0x342DE3E0,
  0x342DE3E1, 0x342DE3E2, 0x342DE3E6, 0x342DE3E7, 0x342DE3E8, 0x342DE3F5,
  0x342DE3F6, 0x342DE3F7, 0x342DE3FB, 0x342DE3FC, 0x342DE3FD, 0x347AA302,
  0x347AA305, 0x374AA205, 0x374AA217, 0x374AA220, 0x374AA223, 0x374AA226,
  0x374AA229, 0x374AA234, 0x374AA237, 0x374AA251, 0x374AA263, 0x374AA268,
  0x374AA311, 0x374AA314, 0x374AA319, 0x374AA322, 0x374AA329, 0x374AA355,
  0x379A1804, 0x379A1807, 0x38A90002, 0x38EE0000, 0x38EE0002, 0x38EE0039,
  0x391D1A04, 0x391D1A08, 0x391D1A0E, 0x391D1A13, 0x391D1A25, 0x391D1A2B,
  0x391D1A34, 0x391D2017, 0x391D2A05,
];

// All zeros is a receiver that has not filled the reply yet, not two empty batteries.
const isFilled = (reply) => reply.length >= REPLY_BYTES && reply.subarray(2, REPLY_BYTES).some((b) => b !== 0);

// 0 right after waking means "not reported yet", so it is no reading either.
function slotPercent(reply, slot) {
  const level = reply[slot.level];
  return reply[slot.offline] === 0 && level > 0 && level <= 100 ? level : null;
}

function decode(reply) {
  const keyboard = slotPercent(reply, KEYBOARD);
  const mouse = slotPercent(reply, MOUSE);
  if (keyboard !== null && mouse !== null) {
    return [{ percent: keyboard, charging: null, suffix: 'keyboard' }, { percent: mouse, charging: null, suffix: 'mouse' }];
  }
  return reading(keyboard ?? mouse);
}

async function read(io) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const reply = await io.feature(STATUS_REQUEST, 0, WAIT_MS);
    if (isFilled(reply)) return decode(reply);
    await io.wait(RETRY_MS);
  }
  return [];
}

module.exports = [{ label: 'Wireless receiver', products: RECEIVERS, page: 0xFFFF, usage: 2, size: FEATURE_BYTES, feature: true, read }];
