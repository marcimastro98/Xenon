'use strict';
// Logitech headsets on a Centurion receiver (G PRO X 2, G522). The receiver answers for
// itself and reaches the headset through its bridge feature. Each step is a feature
// lookup or the battery get, and the bridge only carries them. Frame layout after
// HaloBattery (MIT).
// Older firmware with no 0x0104 feature needs a frame with fixed indexes, left out: it
// would go to a headset nobody has looked up.

const { ids, reading, validPercent } = require('./ids');

const LOGITECH = 0x046D;
const ROOT = 0x00;
const FEATURE_BRIDGE = [0x00, 0x03];
const FEATURE_BATTERY = [0x01, 0x04];
const GET = 0x01;             // function 0, with software id 1
const BRIDGE_SEND = 0x11;
const BRIDGE_ANSWER = 0x10;
const REFUSED = 0xFF;
const AT_DATA = 7;
const CHARGING_STATES = new Set([1, 2]);
const WAIT_MS = 500;

const frame = (prefix, payload) => [...prefix, payload.length + 1, 0x00, ...payload];

function payloadOf(prefix, report) {
  if (!prefix.every((b, i) => report[i] === b)) return null;
  const length = report[prefix.length];
  const end = prefix.length + 1 + length;
  return length > 1 && end <= report.length ? report.subarray(prefix.length + 2, end) : null;
}

async function exchange(io, prefix, payload, accept) {
  const isAnswer = (report) => {
    const answer = payloadOf(prefix, report);
    return answer !== null && accept(answer);
  };
  const report = await io.ask(frame(prefix, payload), isAnswer, WAIT_MS);
  return report && payloadOf(prefix, report);
}

async function findBridge(io, prefix) {
  const answer = await exchange(io, prefix, [ROOT, GET, ...FEATURE_BRIDGE], (p) => p[0] === ROOT && p[1] === GET);
  return answer ? answer[2] : 0;
}

// Null when the headset refused, or the receiver says it is off.
async function askHeadset(io, prefix, bridge, feature, params = []) {
  const message = [0x00, feature, GET, ...params];
  const answered = (p) => p[0] === bridge && p[1] === BRIDGE_ANSWER && p[4] === 0x00 && p[5] === feature && p[6] === GET;
  const refused = (p) => (p[0] === bridge && p[1] === BRIDGE_ANSWER && p[5] === REFUSED && p[6] === feature)
    || (p[0] === REFUSED && p[1] === bridge && p[2] === BRIDGE_SEND);
  const headsetOff = (p) => p[0] === bridge && p[1] === 0x00 && p[2] === 0x00 && p[3] === 0x00;
  const payload = [bridge, BRIDGE_SEND, 0x00, message.length, ...message];
  const answer = await exchange(io, prefix, payload, (p) => answered(p) || refused(p) || headsetOff(p));
  return answer && answered(answer) ? answer.subarray(AT_DATA) : null;
}

function reader(prefix) {
  return async (io) => {
    const bridge = await findBridge(io, prefix);
    if (!bridge) return [];
    const lookup = await askHeadset(io, prefix, bridge, ROOT, FEATURE_BATTERY);
    if (!lookup || !lookup[0]) return [];
    const battery = await askHeadset(io, prefix, bridge, lookup[0]);
    return battery ? reading(validPercent(battery[0]), CHARGING_STATES.has(battery[2])) : [];
  };
}

const model = (label, productId, prefix) => ({
  label, products: ids(LOGITECH, [productId]), page: 0xFFA0, usage: 1, size: 64, read: reader(prefix),
});

module.exports = [
  model('Logitech G PRO X 2', 0x0AF7, [0x51]),
  model('Logitech G522', 0x0B18, [0x50, 0x23]),
];
