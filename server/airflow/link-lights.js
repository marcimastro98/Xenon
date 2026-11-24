'use strict';
// The lights of an iCUE LINK hub while Airflow holds it (driver-link.js): one device in the
// lighting list (lighting-native/held.js), painted through the hub's colour handle. The hub
// lights nothing of its own in software mode, so without this its lights stay off. The
// lights ask for frames at their own pace; while one is on its way only the newest waits,
// so a slow hub never builds a queue. Given back, the hub lights its own saved look again.

const P = require('./corsair-link-protocol.js');
const { layoutOf, frameOf } = require('./corsair-link-lights.js');

const DEVICE_ID = 'corsair-link-hub';
const MODEL = 'iCUE LINK System Hub';
const MAKER = 'CORSAIR';
// The iCUE SDK's type for the hub (a LED controller): the same device either way.
const LED_CONTROLLER = 0x40;

/**
 * @param {{ onChange?: () => void, warn?: (m: string) => void }} [opts] onChange: the device came, went or changed
 */
function createLinkLights({ onChange = () => {}, warn = () => {} } = {}) {
  /** @type {any} */
  let session = null;
  let chainKey = '';
  /** @type {any} */
  let layout = null;
  /** @type {any} */
  let dev = null;
  /** @type {string|null} why a held hub shows no lights: 'unknown-leds' | 'too-many-leds' | 'no-colours' */
  let why = null;
  /** @type {number[]|null} */
  let last = null;
  /** @type {number[]|null} */
  let next = null;
  /** @type {number[]|null} a frame the hub did not take: painted again at the next read */
  let failed = null;
  let sending = false;
  let ok = true;   // one warning per run of failures, not one per frame

  function deviceOf(l) {
    const ledIds = l.segments.flatMap((/** @type {any} */ s) => s.ledIds);
    if (!ledIds.length) return null;
    return { id: DEVICE_ID, model: MODEL, maker: MAKER, source: 'native', type: LED_CONTROLLER, outputs: 0, ledCount: ledIds.length, ledIds, segments: l.segments };
  }

  function send() {
    if (sending || !next || !session) return;
    const data = next;
    const s = session;
    next = null;
    sending = true;
    s.paint(data)
      .then(() => { ok = true; if (s === session) { last = data; failed = null; } })
      .catch((/** @type {Error} */ e) => {
        if (s === session) failed = data;
        if (ok) warn(`airflow: hub lights not painted (${e.message})`);
        ok = false;
      })
      .finally(() => { sending = false; send(); });
  }

  function drop() {
    const had = !!dev;
    session = null; chainKey = ''; layout = null; dev = null; last = null; next = null; failed = null;
    return had;
  }

  /**
   * The hub as Airflow holds it now, after each read: lays its lights out when the chain is
   * new; paints again a frame the hub did not take, or the last one when the hub was found
   * back in hardware mode (its colour handle closed).
   * @param {any} s the session (corsair-link-session.js)
   * @param {{ channel: number, type: number, model: number }[]} chain
   */
  function attach(s, chain) {
    const key = JSON.stringify(chain.map((d) => [d.channel, d.type, d.model]));
    if (s !== session || key !== chainKey) {
      const had = drop();
      session = s;
      chainKey = key;
      const l = layoutOf(chain);
      why = l.ok === false ? l.why : null;
      layout = l.ok === true ? l : null;
      dev = layout ? deviceOf(layout) : null;
      if (had || dev) onChange();
      return;
    }
    const again = failed || (s.coloursOpen() ? null : last);
    if (dev && again && !next && !sending) { failed = null; next = again; send(); }
  }

  // Every light dark: the lights let go of the hub, or the PC goes down (lighting-native).
  function off() {
    next = null;
    if (!dev || !session) return Promise.resolve();
    const s = session;
    const data = P.colourData(frameOf(layout, [], []));
    return s.paint(data)
      .then(() => { if (s === session) last = data; })
      .catch((/** @type {Error} */ e) => warn(`airflow: hub lights not darkened (${e.message})`));
  }

  function detach() {
    why = null;
    if (drop()) onChange();
  }

  /**
   * @param {any} d the device the lights paint
   * @param {({ r: number, g: number, b: number } | null)[]} colors colors[i] is d.ledIds[i]'s
   * @returns {boolean} whether the device was this hub's
   */
  function write(d, colors) {
    if (!dev || !d || d.id !== DEVICE_ID) return false;
    next = P.colourData(frameOf(layout, d.ledIds, colors));
    send();
    return true;
  }

  return {
    attach,
    detach,
    write,
    off,
    devices: () => (dev ? [dev] : []),
    owns: (/** @type {string} */ id) => !!dev && id === DEVICE_ID,
    /** Why the hub Airflow holds shows no lights, or null. */
    why: () => why,
  };
}

module.exports = { createLinkLights, DEVICE_ID };
