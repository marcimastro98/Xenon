'use strict';
// HID input and output reports on Linux, the same link as hid-reports-windows.js. A
// hidraw node is one file: writing sends a report, reading takes the next one. The node
// is non-blocking and polled, because a blocking read of a silent device would hold a
// thread of Node's pool for as long as the device stays quiet.

const fsp = require('fs/promises');
const { constants } = require('fs');

const READ_BYTES = 256;
const POLL_MS = 10;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createOpenReports({ openNode = (p) => fsp.open(p, constants.O_RDWR | constants.O_NONBLOCK), wait = delay } = {}) {
  return async function openReports(interfaces) {
    let file;
    try {
      file = await openNode(interfaces[0].path);
    } catch (e) {
      throw new Error(e.code === 'EACCES' || e.code === 'EPERM' ? 'no-permission' : 'could not open the device');
    }
    let closed = false;

    async function next() {
      const buffer = Buffer.alloc(READ_BYTES);
      try {
        const { bytesRead } = await file.read(buffer, 0, READ_BYTES, null);
        return bytesRead ? buffer.subarray(0, bytesRead) : null;
      } catch (e) {
        if (e.code === 'EAGAIN') return null;
        throw e;
      }
    }

    return {
      async write(bytes) {
        if (closed) throw new Error('device closed');
        await file.write(Buffer.from(bytes), 0, bytes.length, null);
      },
      // One input report, or null when none came in time.
      async read(timeoutMs) {
        if (closed) throw new Error('device closed');
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const report = await next();
          if (report) return report;
          if (Date.now() >= deadline) return null;
          await wait(POLL_MS);
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        await file.close().catch(() => {});
      },
    };
  };
}

module.exports = { openReports: createOpenReports(), createOpenReports };
