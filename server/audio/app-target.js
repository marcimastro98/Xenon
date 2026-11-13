// Turns the name of an app into the form the volume tool needs to find it.

// Normalise a per-app audio target for SoundVolumeView: a bare process name with
// a .exe suffix (the durable identifier the Deck stores, vs. the volatile CLI id).
function appAudioTarget(app) {
  const base = String(app || '').split(/[\\/]/).pop().trim();
  // A blank app name yields a blank target, never the bare ".exe" — which the
  // Linux matcher reads as "every stream on the machine" once the suffix is
  // stripped. Callers refuse an empty target instead of aiming at everything.
  if (!base) return '';
  return /\.exe$/i.test(base) ? base : base + '.exe';
}

module.exports = { appAudioTarget };
