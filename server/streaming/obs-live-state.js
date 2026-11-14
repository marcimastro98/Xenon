// What OBS says while the dashboard watches it: a change of scene, mute, volume or recording
// goes to every open dashboard, with a fresh picture of the scene on air.

const { broadcastSSE } = require('../http/sse-clients.js');
const { scenePreviewRequest } = require('../actions/obs.js');
const { deckObs } = require('./deck-clients.js');
const { obsWatch } = require('./obs-watch-state.js');

function applyObsPartial(partial) {
  if (!partial) return;
  const sceneChanged = ('obsScene' in partial) && partial.obsScene !== obsWatch.state.obsScene;
  if (partial.obsMutes) obsWatch.state.obsMutes = Object.assign({}, obsWatch.state.obsMutes, partial.obsMutes);
  if (partial.obsVolumes) obsWatch.state.obsVolumes = Object.assign({}, obsWatch.state.obsVolumes, partial.obsVolumes);
  if (Array.isArray(partial.obsInputs)) obsWatch.state.obsInputs = partial.obsInputs;
  for (const k of ['obsRecording', 'obsStreaming', 'obsScene']) if (k in partial) obsWatch.state[k] = partial[k];
  broadcastSSE('obs', obsWatch.state);
  if (sceneChanged && obsWatch.previewTimer) captureScenePreview(); // refresh the preview instantly on a scene switch
}

async function captureScenePreview() {
  const scene = obsWatch.state.obsScene;
  if (!scene) return;                         // no program scene yet
  try {
    const r = scenePreviewRequest(scene);
    const resp = await deckObs.request(r.requestType, r.requestData);
    if (resp && resp.imageData) {
      // Skip the rebroadcast when the frame is byte-identical to the last one — a
      // static program scene otherwise re-pushes the same base64 image every 5s.
      if (resp.imageData !== obsWatch.preview.image || scene !== obsWatch.preview.scene) {
        obsWatch.preview = { scene, image: resp.imageData };
        broadcastSSE('obs_preview', obsWatch.preview);
      }
    }
  } catch (e) { /* keep the last image on a failed/again-later capture */ }
}

module.exports = { applyObsPartial, captureScenePreview };
