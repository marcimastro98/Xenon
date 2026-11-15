'use strict';
// One call into the iCUE SDK: its time limit, its error, and what a failed call says about the
// link.

const { bridge } = require('./bridge-state.js');

const wokenBoards = new Set();    // motherboards already woken in this iCUE session (see wakeVendorBoard)

// Hard ceiling for any single SDK round-trip. The iCUE SDK talks to the iCUE
// service over a synchronous cross-process channel; if that service is busy or
// wedged a call can hang indefinitely. Every SDK call below goes through the
// async koffi binding (worker thread, never the event loop) AND this timeout,
// so a stuck service degrades the bridge to a no-op instead of freezing Node.
const SDK_OP_TIMEOUT_MS = 2500;

// Reject if `promise` doesn't settle within SDK_OP_TIMEOUT_MS. The underlying
// koffi async call can't be cancelled (it keeps running on a worker thread),
// but the event loop is freed immediately so the server stays responsive.
function withSdkTimeout(promise, label) {
  let t;
  const guard = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label + ' timed out after ' + SDK_OP_TIMEOUT_MS + 'ms')), SDK_OP_TIMEOUT_MS);
    if (t.unref) t.unref();
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), guard]);
}

// CorsairError names (official iCUE SDK v4 header), so a failure reads as
// something a user can act on instead of a bare number.
const CE_NAMES = {
  0: 'CE_Success', 1: 'CE_NotConnected', 2: 'CE_NoControl', 3: 'CE_IncompatibleProtocol',
  4: 'CE_InvalidArguments', 5: 'CE_InvalidOperation', 6: 'CE_DeviceNotFound', 7: 'CE_NotAllowed',
};
const CE_NOT_CONNECTED = 1;

class SdkError extends Error {
  constructor(label, rc) {
    super(`${label} rc=${rc} (${CE_NAMES[rc] || 'unknown'})`);
    this.rc = rc;
  }
}

// Run an SDK call and FAIL on a non-zero return code.
//
// The SDK reports failure through the return code, never an exception: the koffi
// callback's `err` is only set when the FFI call itself breaks. Discarding the rc
// meant a dead session (iCUE restarted or reinstalled under us) answered
// CE_NotConnected on every write while `connected` stayed true — the write was a
// silent no-op, the on-change cache in writeDevice() recorded it as painted, and
// nothing ever retried or told the user. Every SDK call goes through here now.
function sdkCall(fn, label, ...args) {
  return withSdkTimeout(new Promise((resolve, reject) => {
    fn.async(...args, (err, rc) => {
      if (err) return reject(err);
      if (rc !== 0) return reject(new SdkError(label, rc));
      resolve();
    });
  }), label);
}

// A write that failed because the session is gone must drop `connected`, so
// maybeReconnectForPaint() can rebuild it on the next apply() tick. Without this
// the bridge sits on a dead handle forever: the state callback fires only for
// transitions the SDK still knows about, and a service that died under us never
// sends one.
function noteSdkFailure(e) {
  bridge.lastError = e.message;
  if (e instanceof SdkError && e.rc === CE_NOT_CONNECTED) {
    bridge.connected = false;
    bridge.devices = [];
    wokenBoards.clear();
    bridge.lastWrite.clear();
  }
}

module.exports = {
  wokenBoards, SDK_OP_TIMEOUT_MS, withSdkTimeout, CE_NAMES, CE_NOT_CONNECTED, SdkError, sdkCall,
  noteSdkFailure,
};
