// What the camera alerts go by: the alert settings as last read, and their signature, so the
// watch is restarted only when they change.

const unifiNotify = {
  configSig: null,
  snapshot: null,          // { enabled, types, cooldownMs } — refreshed by refreshUnifiEventsWatch
};

module.exports = { unifiNotify };
