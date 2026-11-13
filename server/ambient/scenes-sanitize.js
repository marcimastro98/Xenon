// The saved Ambient scenes as the settings keep them: within the store limits, and only what
// can be written to a file.

const AmbientScene = require('../js/ambient-scene.js');

// Native canvas Ambient scenes — client-owned array (like customThemes). The
// server round-trips a bounded copy so scenes survive a restart; the client
// deep-normalizes through the shared AmbientScene module on hydrate (the
// security edge — text→textContent, image-src allowlist, SDK grants), so here
// we only cap the count and sizes against a hostile blob. The caps are the
// import's own (AmbientScene.fitScenes): a scene shared with its pictures
// inlined is up to a share code's size, and used to vanish here on save.
function sanitizeAmbientScenes(value) {
  return AmbientScene.fitScenes(value).flatMap((scene) => {
    try { return [JSON.parse(JSON.stringify(scene))]; } catch { return []; }   // unserializable → drop
  });
}

module.exports = { sanitizeAmbientScenes };
