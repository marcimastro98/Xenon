'use strict';

// What POST /backup/import was sent: the file, and what the person answered at the PC.
//
// The request is { bundle: <the file>, keepDeckActions: true|absent }. The answer is read from
// the request and from nowhere else: a file is data somebody else may have written, so nothing
// inside it may answer for the person. A file sent as it is (the older shape of this request,
// still taken) is all file: whatever it says at its top is the file's word and is not read.

/** Bytes the request may add around a file of the largest size. */
const REQUEST_ROOM = 64;

/** @param {any} value @returns {Record<string, any> | null} */
const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

/**
 * @param {any} body the request as parsed
 * @returns {{ bundle: any, keepDeckActions: boolean }} `keepDeckActions` only for the literal `true` beside the file
 */
function importRequest(body) {
  const sent = plain(body);
  // A backup names its format at the top (xenonBackup): with that, the body is the file itself.
  if (!sent || Object.hasOwn(sent, 'xenonBackup') || !plain(sent.bundle)) return { bundle: body, keepDeckActions: false };
  return { bundle: sent.bundle, keepDeckActions: sent.keepDeckActions === true };
}

module.exports = { importRequest, REQUEST_ROOM };
