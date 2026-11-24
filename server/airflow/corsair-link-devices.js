'use strict';
// What sits on an iCUE LINK chain, from the type and model bytes of the hub's device
// list. The codes are facts about the hardware, gathered from public observations of
// the hub (no code taken from anyone). A type Xenon does not know is never driven:
// it is listed as 'other' so its readings still show.

// kind: 'fan' | 'pump' | 'other'. temp: the device reports a temperature on its channel.
const TYPES = new Map([
  [0x01, { kind: 'fan', name: 'QX fan', temp: true }],
  [0x02, { kind: 'fan', name: 'LX fan' }],
  [0x03, { kind: 'fan', name: 'RX MAX RGB fan' }],
  [0x04, { kind: 'fan', name: 'RX MAX fan' }],
  [0x0f, { kind: 'fan', name: 'RX RGB fan' }],
  [0x13, { kind: 'fan', name: 'RX fan' }],
  [0x10, { kind: 'fan', name: 'VRM fan module' }],
  [0x07, { kind: 'pump', name: 'AIO pump', temp: true }],
  [0x11, { kind: 'pump', name: 'TITAN AIO pump', temp: true }],
  [0x0c, { kind: 'pump', name: 'XD5 pump', temp: true }],
  [0x19, { kind: 'pump', name: 'XD6 pump', temp: true }],
  [0x09, { kind: 'other', name: 'XC7 block', temp: true }],
  [0x0a, { kind: 'other', name: 'XG3 block' }],
  [0x0d, { kind: 'other', name: 'XG7 block' }],
  [0x0b, { kind: 'other', name: 'HXi SHIFT power supply' }],
  [0x1b, { kind: 'other', name: 'COMMANDER DUO' }],
  [0x05, { kind: 'other', name: 'LINK adapter' }],
  [0x06, { kind: 'other', name: 'LCD screen' }],
  [0x0e, { kind: 'other', name: 'LCD screen' }],
]);

// The AIO pumps name their radiator in the model byte.
const AIO_MODELS = new Map([[0x00, 'H100i'], [0x01, 'H115i'], [0x02, 'H150i'], [0x03, 'H170i'], [0x04, 'H100i'], [0x05, 'H150i']]);

// Newer devices share one type and tell themselves apart by the model byte.
const SHARED_TYPE = 0x1a;
const SHARED_MODELS = new Map([
  [0x00, { kind: 'fan', name: 'LINK fan' }],
  [0x01, { kind: 'pump', name: 'AIO pump', temp: true }],
  [0x08, { kind: 'other', name: 'LCD screen' }],
]);

/**
 * @param {number} type
 * @param {number} model
 * @returns {{ kind: 'fan'|'pump'|'other', name: string, temp: boolean, known: boolean }}
 */
function linkDevice(type, model) {
  const base = type === SHARED_TYPE ? SHARED_MODELS.get(model) : TYPES.get(type);
  if (!base) return { kind: 'other', name: 'LINK device', temp: false, known: false };
  const aio = type === 0x07 && AIO_MODELS.get(model);
  return { kind: /** @type {'fan'|'pump'|'other'} */ (base.kind), name: aio ? `${aio} pump` : base.name, temp: !!base.temp, known: true };
}

module.exports = { linkDevice };
