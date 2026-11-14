'use strict';
// What Wave Link pushes without being asked: a change of a channel, a mix, an output or a
// level, in either dialect, merged into what is known about the mixer.

const { adaptV3Channels, adaptV3Mixes } = require('./wavelink-shape.js');

function makePushes({
  wlMixer, v2Raw, v3MixRaw, channels, ingestMeters, notify, mergeV3Raw, reindexV2, ingestV2Channels,
  refreshChannels, refreshOutputs,
}) {
  function applyNotification(method, params) {
    if (wlMixer.dialect === 3) return applyV3Notification(method, params);
    return applyV2Notification(method, params);
  }

  function applyV2Notification(method, params) {
    if (method === 'inputMixerChanged') {
      const id = params.mixId != null ? String(params.mixId) : '';
      if (!id) return;
      // Keep the RAW 2.x record: a write echoes the WHOLE object back, so the
      // cache has to carry every field, not just the normalised subset.
      v2Raw.set(id, Object.assign(v2Raw.get(id) || {}, params, { mixId: id }));
      reindexV2();
      notify();
    } else if (method === 'outputMixerChanged') {
      wlMixer.outputRaw = Object.assign(wlMixer.outputRaw || {}, params); notify();
    } else if (method === 'microphoneStateChanged') {
      wlMixer.micConnected = !!params.isMicrophoneConnected; notify();
    } else if (method === 'localMonitorOutputChanged') {
      wlMixer.monitorMix = params.monitorMix != null ? String(params.monitorMix) : wlMixer.monitorMix; notify();
    } else if (method === 'monitorSwitchOutputChanged') {
      wlMixer.switchState = params.switchState != null ? String(params.switchState) : wlMixer.switchState; notify();
    } else if (method === 'channelsChanged') {
      ingestV2Channels(params.channels); notify();
    }
  }

  function applyV3Notification(method, params) {
    if (method === 'channelChanged') {
      const id = params.id != null ? String(params.id) : '';
      if (!id) return;
      const [patched] = adaptV3Channels([mergeV3Raw(id, params)]);
      if (patched) channels.set(id, patched);
      notify();
    } else if (method === 'channelsChanged') {
      // A structural change (added/removed/renamed) — re-read rather than patch.
      refreshChannels().catch(() => {});
    } else if (method === 'mixChanged') {
      const id = params.id != null ? String(params.id) : '';
      if (!id) return;
      const next = wlMixer.mixes.slice();
      const at = next.findIndex((m) => m.id === id);
      const [adapted] = adaptV3Mixes([Object.assign({}, at >= 0 ? v3MixRaw.get(id) || {} : {}, params)]);
      if (adapted) { if (at >= 0) next[at] = adapted; else next.push(adapted); }
      v3MixRaw.set(id, Object.assign(v3MixRaw.get(id) || {}, params));
      wlMixer.mixes = next;
      notify();
    } else if (method === 'outputDeviceChanged') {
      refreshOutputs().catch(() => {});
    } else if (method === 'levelMeterChanged') {
      ingestMeters(params);
      notify();
    }
  }

  return { applyNotification };
}

module.exports = { makePushes };
