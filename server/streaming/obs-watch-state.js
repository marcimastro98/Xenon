// What the engine last heard from OBS, the picture of the scene on air and the clock that
// refreshes it.

const obsWatch = {
  // Live OBS state pushed to the dashboard while it's open and OBS is configured.
  // The persistent OBS connection is held only when both are true, so a closed
  // dashboard or an unconfigured OBS keeps zero sockets open.
  state: { obsRecording: false, obsStreaming: false, obsScene: '', obsMutes: {}, obsVolumes: {}, obsInputs: [] },
  // Live thumbnail of the OBS program (on-air) scene, pushed on its own SSE event so
  // the (larger) image never rides the frequent small `obs` state updates.
  preview: { scene: '', image: '' },
  previewTimer: null,
};

module.exports = { obsWatch };
