'use strict';
// USB HID access for lighting controllers Xenon drives itself. One backend per
// OS behind the same { list, open } shape; where none exists yet, `available`
// is false and `reason` says so, so the UI explains instead of failing.

function backend() {
  if (process.platform === 'win32') return require('./hid-windows.js');
  if (process.platform === 'linux') return require('./hid-linux.js');
  return null;
}

const hid = backend();

module.exports = {
  available: !!hid,
  beta: !!(hid && hid.beta),
  reason: hid ? '' : 'Direct USB lighting control works on Windows and Linux.',
  list: (filter) => (hid ? hid.list(filter) : Promise.resolve([])),
  open: (info) => (hid ? hid.open(info) : Promise.reject(new Error('USB lighting control is not available on this OS'))),
};
