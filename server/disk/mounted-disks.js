'use strict';

// Off Windows the only way to ask what is mounted is a process (`df`, plus `mount` on macOS), and
// every sensor read asks. Disks change slowly: a new drive and a change in free space show within
// this window, as a new drive does within a minute on Windows.
const MOUNTED_DISKS_TTL_MS = 30 * 1000;

const copyOf = (drives) => drives.map((drive) => ({ ...drive }));

// `read` answers an array, or null when it failed. A failure stays visible to the caller as it
// always was, and is not kept: the next read tries again.
function createMountedDisks(read, { now = Date.now } = {}) {
  let drives = null;
  let readAt = 0;
  let reading = null;

  function readDisks() {
    reading = Promise.resolve(read()).then((fresh) => {
      drives = fresh;
      readAt = now();
      return fresh;
    }).finally(() => { reading = null; });
    return reading;
  }

  return async function mountedDisks() {
    if (drives && now() - readAt < MOUNTED_DISKS_TTL_MS) return copyOf(drives);
    const fresh = await (reading || readDisks());
    return fresh && copyOf(fresh);
  };
}

module.exports = { createMountedDisks, MOUNTED_DISKS_TTL_MS };
