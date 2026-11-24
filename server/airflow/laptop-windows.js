'use strict';
// A laptop on Windows: a battery of the system that is not a UPS. Read once from
// CallNtPowerInformation(SystemPowerCapabilities) through koffi, on its worker thread
// with a ceiling (no PowerShell, no WMI). A laptop's firmware owns its fans, so Airflow
// says "laptop" there (drivers.js notOnLaptop). Lid switches are not trusted alone:
// some desktop boards declare one.

const SYSTEM_POWER_CAPABILITIES = 4;
// SYSTEM_POWER_CAPABILITIES: 32 one-byte fields, three 8-byte battery scales, five enums.
const CAPS_BYTES = 76;
const BATTERIES_PRESENT = 30;
const BATTERIES_SHORT_TERM = 31;
const CALL_TIMEOUT_MS = 2000;

/** @param {Uint8Array} caps @returns {boolean} */
function laptopFromCaps(caps) {
  if (!caps || caps.length < CAPS_BYTES) return false;
  // A UPS is a battery of the system too, but a short-term one.
  return caps[BATTERIES_PRESENT] !== 0 && caps[BATTERIES_SHORT_TERM] === 0;
}

let fn = null;
function load() {
  if (fn) return fn;
  const koffi = require('koffi');
  fn = koffi.load('powrprof.dll').func('uint32 __stdcall CallNtPowerInformation(int, void *, uint32, _Out_ void *, uint32)');
  return fn;
}

/** @returns {Promise<boolean>} false when the answer cannot be read: never a guess against the person */
async function windowsLaptop() {
  const caps = Buffer.alloc(CAPS_BYTES);
  let timer = null;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('power call timed out')), CALL_TIMEOUT_MS); });
  const run = new Promise((resolve, reject) => {
    load().async(SYSTEM_POWER_CAPABILITIES, null, 0, caps, CAPS_BYTES, (err, rc) => (err ? reject(err) : resolve(rc)));
  });
  try {
    const rc = await Promise.race([run, guard]);
    return rc === 0 && laptopFromCaps(caps);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { windowsLaptop, laptopFromCaps, CAPS_BYTES };
