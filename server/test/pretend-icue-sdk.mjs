// A pretend iCUE SDK for the lighting bridge's tests (lighting-cycle, lighting-pump-ring): put
// in the bridge's shared state before lighting.js is required, so the real library is never
// loaded and no real device is touched. Only what the bridge says to the SDK is recorded.

const SESSION_CONNECTED = 6;
const NOT_CONNECTED = 1;   // CE_NotConnected
// The channel properties lights/sdk-properties.js reads, and the shape it reads them in.
const CHANNEL_LED_COUNTS = 12;
const CHANNEL_TYPES = 13;
const INT32_ARRAY = 17;

// The SDK as the bridge sees it: functions with koffi's `.async` form, answered on a later turn of
// the event loop as a worker thread would, and a session-state callback.
// devices: [{ type, id, serial, model, ledCount, channelCount }]; ledBase(id): the first LED id of each;
// channels: { [deviceId]: [{ ledCounts: [n], types: [t] }] }, what each channel holds.
export function pretendSdk({ devices, ledBase, channels = {} }) {
  const sdk = {
    log: [],                // [{ fn, id?, colors? }] every call, in order
    devices,
    withoutLights: new Map(),   // device id -> how many more times it answers with no LED positions
    writeAnswers: [],           // return codes for the next writes (0 when empty)
    registered: 0,
    unregistered: 0,
    stateCb: null,
  };
  const later = (fn) => setImmediate(fn);
  const asyncFn = (name, run) => ({ async: (...args) => { const done = args.pop(); later(() => done(null, run(...args))); } });
  sdk.koffi = {
    register: (fn) => { sdk.registered += 1; return fn; },
    unregister: () => { sdk.unregistered += 1; },
    pointer: (name) => name,
    // A channel list comes back as the items the pretend read put on the buffer.
    decode: (value, type) => (type === 'int' && value && value.pretendItems ? value.pretendItems : value),
  };
  sdk.say = (state) => sdk.stateCb(null, { state });
  sdk.fns = {
    connect: (cb) => { sdk.log.push({ fn: 'connect' }); sdk.stateCb = cb; later(() => sdk.say(SESSION_CONNECTED)); return 0; },
    disconnect: asyncFn('disconnect', () => { sdk.log.push({ fn: 'disconnect' }); return 0; }),
    getDevices: asyncFn('getDevices', (_filter, _max, buf, count) => {
      sdk.log.push({ fn: 'getDevices' });
      sdk.devices.forEach((d, i) => { buf[i] = { ...d }; });
      count[0] = sdk.devices.length;
      return 0;
    }),
    getLedPositions: asyncFn('getLedPositions', (id, ledCount, pos, pc) => {
      sdk.log.push({ fn: 'getLedPositions', id });
      const left = sdk.withoutLights.get(id) || 0;
      if (left > 0) { sdk.withoutLights.set(id, left - 1); pc[0] = 0; return 0; }
      for (let i = 0; i < ledCount; i += 1) pos[i] = { id: ledBase(id) + i, cx: i * 10, cy: 0 };
      pc[0] = ledCount;
      return 0;
    }),
    setLedColors: asyncFn('setLedColors', (id, n, arr) => {
      sdk.log.push({ fn: 'setLedColors', id, colors: arr.slice(0, n).map((c) => ({ ...c })) });
      return sdk.writeAnswers.length ? sdk.writeAnswers.shift() : 0;
    }),
    readProperty: asyncFn('readProperty', (id, prop, index, buf) => {
      const ch = (channels[id] || [])[index];
      const items = ch && (prop === CHANNEL_LED_COUNTS ? ch.ledCounts : prop === CHANNEL_TYPES ? ch.types : null);
      if (!items) return NOT_CONNECTED;
      buf.writeInt32LE(INT32_ARRAY, 0);
      buf.writeUInt32LE(items.length, 16);
      buf.pretendItems = items;
      return 0;
    }),
    freeProperty: asyncFn('freeProperty', () => 0),
  };
  return sdk;
}
