// Small steps on what is playing: the position moved forward to now, the same-track test, and
// the cleaned name of the preferred player.

function sanitizeMediaSourcePreference(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
}

function liveMediaSnapshot(data, ageMs) {
  if (!data) return data;
  const snapshot = { ...data };
  if (snapshot.playbackStatus === 'Playing' && snapshot.duration) {
    const position = Number(snapshot.position) || 0;
    const duration = Number(snapshot.duration) || 0;
    snapshot.position = Math.min(duration, position + Math.floor(ageMs / 1000));
    // The unrounded twin (hosts that send it) ages by the exact time, so the
    // lyrics clock is not up to a second off.
    const positionMs = Number(snapshot.positionMs);
    if (Number.isFinite(positionMs)) snapshot.positionMs = Math.round(Math.min(duration * 1000, positionMs + ageMs));
  }
  return snapshot;
}

// Is this read plausibly the SAME track as the remembered one? A single naive
// key would force a choice between two failure modes, because SMTC routinely
// drops the artist (and/or album) on a transient read while keeping the title —
// so the very read we want to backfill looks like `title|''`:
//   • key on title+artist+album → the transient drop changes the key → no
//     backfill exactly when the cover flickers (the bug we're fixing);
//   • key on title alone → two different untagged tracks that share a title
//     collide and inherit each other's cover.
// So match tolerantly: the title must match, and each of artist/album must
// either match or be ABSENT on the incoming read (an empty field carries no new
// info — treat it as "unchanged", not "different"). A DIFFERING non-empty
// artist or album is a real other track and blocks the backfill, so covers never
// bleed between two songs that merely share a title AND carry any distinguishing
// tag. The one irreducible case — two fully-untagged tracks with byte-identical
// titles back to back — is indistinguishable from a single read; we favour the
// common flicker fix over that rare collision.
function _sameStickyTrack(data, ref) {
  const title = (data && data.title) || '';
  if (!title || title !== ref.title) return false;
  const artist = (data && data.artist) || '';
  const album = (data && data.album) || '';
  if (artist && ref.artist && artist !== ref.artist) return false;
  if (album && ref.album && album !== ref.album) return false;
  return true;
}

module.exports = { sanitizeMediaSourcePreference, liveMediaSnapshot, _sameStickyTrack };
