// What the Deck's keys read from the PC as it is now: the last state heard, the value a slider
// shows from it, and whether any key shows a given state.
'use strict';

(() => {
  const { readStore } = window.DeckStoreReads;

  // Latest known live state; key nodes bound via data-state-bound reflect it.
  const stateSnapshot = { benchmarkRunning: false, recordingOn: false, timelapseOn: false, stepsOn: false, replayOn: false, micMuted: false, speakerMuted: false, obsRecording: false, obsStreaming: false, obsScene: '', obsMutes: {}, remoteConnected: false, remoteActive: false, sbGlobals: {}, sdkStates: {}, sdkStateMeta: {}, scriptStates: {}, discordMuted: false, discordDeafened: false, mediaPlaying: false, mediaSource: '', haStates: {}, timers: {}, masterVolume: NaN, discordInputVolume: NaN, discordOutputVolume: NaN, lightsOn: false, outputDevice: '' };

  // Whether a key on any Deck shows one of these live states, in view or not.
  function usesState(sources) {
    const all = readStore();
    return Object.keys(all).some((id) => window.DeckStore.isInstanceKey(id) && window.DeckModel.deckUsesState(all[id], sources));
  }

  // Current live value for a slider's target from the state snapshot (0–100),
  // or null when the target has NO live feed (per-app/Spotify/OBS volumes
  // aren't broadcast) — null means "leave the fader where the user put it"
  // instead of faking a value and snapping their drag back.
  function sliderLiveValue(slider) {
    switch (slider.target) {
      case 'volume':        return Number.isFinite(stateSnapshot.masterVolume) ? stateSnapshot.masterVolume : null;
      case 'haLight': {
        const entry = slider.entity && stateSnapshot.haStates ? stateSnapshot.haStates[slider.entity] : null;
        if (!entry) return null;
        if (typeof entry.brightness === 'number') return Math.round((entry.brightness / 255) * 100);
        return entry.state === 'on' ? 100 : 0;
      }
      case 'discordInput':  return Number.isFinite(stateSnapshot.discordInputVolume) ? stateSnapshot.discordInputVolume : null;
      case 'discordOutput': return Number.isFinite(stateSnapshot.discordOutputVolume) ? Math.min(100, stateSnapshot.discordOutputVolume) : null;
      default: return null;   // appVolume / spotifyVolume / obsInput: write-only targets
    }
  }

  window.DeckLiveState = { stateSnapshot, usesState, sliderLiveValue };
})();
