'use strict';
// Writes an upload to disk as it arrives, counting its bytes against the size limit, and leaves
// nothing behind when it fails.

const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { openAtomicWriteStream } = require('../atomic-write.js');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Stream a request body to disk, bounded, without ever holding it in memory.
 *
 * Lives here rather than inline in the route so that the one piece of this
 * feature with no second chance can be exercised for real. That was not
 * caution: the first version of this deadlocked on commit and every upload
 * would have hung at 100%, and it looked completely correct.
 *
 * Two decisions the shape depends on:
 *
 *  * `req` is deliberately NOT part of the pipeline. `pipeline` destroys every
 *    stream it is given when one fails, and destroying the request destroys the
 *    socket — so an over-size upload would get a connection reset instead of
 *    the 413 that tells it what happened, and the client would retry forever.
 *    Piping in by hand keeps backpressure (that is `pipe`'s job) while leaving
 *    the request alive to be answered.
 *  * The size is checked DURING the stream, not from Content-Length. A
 *    Content-Length is a claim, and chunked encoding carries none at all.
 *
 * On failure the temp file is removed and the error carries `code` (one of
 * XFER_TOO_BIG / XFER_ABORTED / a system code) plus how many bytes arrived.
 *
 * @param {import('http').IncomingMessage} req
 * @param {string} target final path; the write goes to `<target>.part` first
 * @param {{limit:number, onProgress?:(n:number)=>void}} opts
 * @returns {Promise<{bytes:number}>}
 */
async function receiveStream(req, target, opts) {
  const o = opts || {};
  const limit = Number(o.limit) > 0 ? Number(o.limit) : DEFAULT_MAX_BYTES;
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
  const handle = await openAtomicWriteStream(target);
  let received = 0;

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > limit) {
        cb(Object.assign(new Error('too_big'), { code: 'XFER_TOO_BIG' }));
        return;
      }
      if (onProgress) onProgress(received);
      cb(null, chunk);          // the same Buffer through, never a copy
    },
  });

  const onReqError = (e) => counter.destroy(e);
  const onReqAborted = () => counter.destroy(Object.assign(new Error('aborted'), { code: 'XFER_ABORTED' }));

  try {
    req.on('error', onReqError);
    req.on('aborted', onReqAborted);
    req.pipe(counter);
    await pipeline(counter, handle.stream);
    await handle.commit();
    return { bytes: received };
  } catch (e) {
    await handle.abort();
    throw Object.assign(e || new Error('write_failed'), { received });
  } finally {
    req.off('error', onReqError);
    req.off('aborted', onReqAborted);
    try { req.unpipe(counter); } catch { /* already unpiped by the failure */ }
  }
}

module.exports = { DEFAULT_MAX_BYTES, receiveStream };
