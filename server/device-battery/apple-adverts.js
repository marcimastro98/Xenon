'use strict';
// What AirPods and Beats broadcast by themselves: Apple's nearby-pairing advert, company
// 0x004C, type 0x07. Levels are in tens, one nibble each, and 15 means "not known", which
// is the usual answer for a bud in its case or a case with its lid shut.
//
// Anyone's AirPods broadcast this, and nothing ties the advert to the pair connected here.
// So it is read only while a pair is connected, and only the strongest signal, close by.

const TYPE = 0x07;
const MINIMUM_BYTES = 8;
const BUDS_AT = 6;
const CASE_AT = 7;
const HIGHEST_LEVEL = 10;
const BUDS_CHARGING = 0x3;
const CASE_CHARGING = 0x4;
const WEAKEST_RSSI = -75;   // further than the next room: not worth calling it theirs

const level = (nibble) => (nibble <= HIGHEST_LEVEL ? nibble * 10 : null);

function decodeAdvert(hex) {
  const bytes = Buffer.from(String(hex), 'hex');
  if (bytes.length < MINIMUM_BYTES || bytes[0] !== TYPE) return null;
  const flags = bytes[CASE_AT] >> 4;
  return {
    buds: [level(bytes[BUDS_AT] >> 4), level(bytes[BUDS_AT] & 0xF)].filter((percent) => percent !== null),
    case: level(bytes[CASE_AT] & 0xF),
    budsCharging: (flags & BUDS_CHARGING) !== 0,
    caseCharging: (flags & CASE_CHARGING) !== 0,
  };
}

function devicesFrom({ connected, adverts }) {
  const name = Array.isArray(connected) ? connected[0] : null;
  if (!name || !Array.isArray(adverts)) return [];
  const nearby = adverts.filter((advert) => advert.rssi >= WEAKEST_RSSI).sort((a, b) => b.rssi - a.rssi);
  const reading = nearby.length ? decodeAdvert(nearby[0].hex) : null;
  if (!reading) return [];
  const devices = [];
  // The lower bud is the one that ends the listening.
  if (reading.buds.length) devices.push({ name, percent: Math.min(...reading.buds), charging: reading.budsCharging, source: 'bluetooth' });
  if (reading.case !== null) devices.push({ name: `${name} case`, percent: reading.case, charging: reading.caseCharging, source: 'bluetooth' });
  return devices;
}

module.exports = { decodeAdvert, devicesFrom };
