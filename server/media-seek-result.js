'use strict';

// The platform hosts speak the same small error vocabulary to the action
// registry. Keep unknown/native failures out of that public contract: a player
// refusing timeline control is `not_seekable`; a missing/broken host is
// `unavailable`; malformed input stays `bad_position`.
const MEDIA_SEEK_ERRORS = new Set(['bad_position', 'not_seekable', 'unavailable']);

function mediaSeekFailure(result) {
  const error = result && typeof result.error === 'string'
    ? result.error.trim().toLowerCase()
    : '';
  return MEDIA_SEEK_ERRORS.has(error) ? error : 'unavailable';
}

function normalizeMediaSeekResult(result, requestedPosition) {
  if (!result || result.ok !== true) {
    return { ok: false, error: mediaSeekFailure(result) };
  }
  const nativePosition = Number(result.position);
  return {
    ...result,
    ok: true,
    position: Number.isFinite(nativePosition) ? nativePosition : requestedPosition,
  };
}

module.exports = { mediaSeekFailure, normalizeMediaSeekResult };
