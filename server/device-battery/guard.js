'use strict';
// What stands between the reader and each device. It tells the parent which device is
// being touched, so one that crashes or hangs the reader can be left out of the next
// reads, and it remembers when the OS refused access, so the UI can say how to grant it.

const NO_PERMISSION = 'no-permission';

const keyOf = (target) => (typeof target === 'string'
  ? target
  : `${target.vendorId.toString(16)}:${target.productId.toString(16)}`);

function createGuard({ skip = [], note = () => {} } = {}) {
  const left = new Set(skip);
  let denied = false;

  function enter(target) {
    const key = keyOf(target);
    if (left.has(key)) throw new Error('device left out');
    note(key);
  }

  const leave = () => note(null);

  // open(...args) of any backend; `target` picks the device out of its arguments.
  function around(open, target) {
    return async (...args) => {
      enter(target(...args));
      let link;
      try {
        link = await open(...args);
      } catch (e) {
        leave();
        if (e.message === NO_PERMISSION) denied = true;
        throw e;
      }
      return { ...link, close: () => Promise.resolve(link.close()).finally(leave) };
    };
  }

  return {
    enter,
    leave,
    wrapHid: (hid) => ({ ...hid, open: around(hid.open, (info) => info) }),
    wrapReports: (openReports) => around(openReports, (interfaces) => interfaces[0]),
    get denied() { return denied; },
  };
}

module.exports = { createGuard, keyOf };
