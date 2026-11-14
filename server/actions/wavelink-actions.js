'use strict';
// What a Deck action does to Wave Link: a volume, a mute, an output, a mix or a monitor switch,
// written the way each dialect wants it.

const {
  clampVolume, unitFromPct, V2_MIX_LOCAL, resolveMixTargets,
} = require('./wavelink-shape.js');

function makeActions({
  wlMixer, v2Raw, channels, reindexV2, refreshOutputs, ensureSeeded, request,
}) {
  // ── writes ─────────────────────────────────────────────────────────────────
  //
  // 2.x replaces the WHOLE input object, so every field is echoed back with only
  // the targeted one changed. 3.x accepts a partial patch (measured: sending
  // {id, level} left name, mute, mixes and effects untouched), so it sends only
  // what it means to change and never risks reviving a stale cached field.
  function pushV2Input(raw, slider) {
    return request('setInputMixer', {
      mixId: raw.mixId,
      slider,
      localVolumeIn: raw.localVolumeIn,
      isLocalInMuted: !!raw.isLocalInMuted,
      streamVolumeIn: raw.streamVolumeIn,
      isStreamInMuted: !!raw.isStreamInMuted,
      filters: raw.filters || [],
      localMixFilterBypass: !!raw.localMixFilterBypass,
      streamMixFilterBypass: !!raw.streamMixFilterBypass,
    });
  }

  function pushV2Output() {
    const o = wlMixer.outputRaw || {};
    return request('setOutputMixer', {
      localVolumeOut: o.localVolumeOut,
      isLocalOutMuted: !!o.isLocalOutMuted,
      streamVolumeOut: o.streamVolumeOut,
      isStreamOutMuted: !!o.isStreamOutMuted,
    });
  }

  async function runAction(action) {
    try {
      if (!action || typeof action !== 'object') return { ok: false, error: 'bad_wl_action' };
      const type = action.type;

      if (type === 'wlInputVolume' || type === 'wlInputMute') {
        await ensureSeeded();
        const id = String(action.mixId == null ? '' : action.mixId);
        const ch = channels.get(id);
        if (!ch) return { ok: false, error: 'wl_unknown_channel' };
        const targets = resolveMixTargets(ch.mixes, action.mix);
        if (!targets.length) {
          // A mix the user can see but this channel is not routed INTO is a
          // different problem from a mix that no longer exists, and only one of
          // the two is the user's mistake. Wave Link genuinely cannot set a
          // level for an unrouted channel, so both refuse — but they say which.
          const known = wlMixer.mixes.some((m) => m.id === String(action.mix));
          return { ok: false, error: known ? 'wl_channel_not_in_mix' : 'wl_unknown_mix' };
        }
        const setVol = type === 'wlInputVolume';
        const vol = setVol ? clampVolume(action.value) : null;
        if (setVol && vol == null) return { ok: false, error: 'bad_volume' };

        if (wlMixer.dialect === 3) {
          const patch = targets.map((mixId) => {
            const cur = ch.mixes.find((m) => m.id === mixId) || {};
            return setVol ? { id: mixId, level: unitFromPct(vol) } : { id: mixId, isMuted: !cur.muted };
          });
          await request('setChannel', { id, mixes: patch });
        } else {
          const raw = v2Raw.get(id);
          if (!raw) return { ok: false, error: 'wl_unknown_channel' };
          for (const mixId of targets) {
            if (mixId === V2_MIX_LOCAL) { if (setVol) raw.localVolumeIn = vol; else raw.isLocalInMuted = !raw.isLocalInMuted; }
            else { if (setVol) raw.streamVolumeIn = vol; else raw.isStreamInMuted = !raw.isStreamInMuted; }
          }
          await pushV2Input(raw, targets.length > 1 ? 'all' : (targets[0] === V2_MIX_LOCAL ? 'local' : 'stream'));
          reindexV2();
        }
        return { ok: true };
      }

      // The mix master. On 2.x this is the output mixer's two sliders; on 3.x it
      // is setMix on the user's own mix, which is the same control wearing the
      // name its owner gave it.
      if (type === 'wlOutputVolume' || type === 'wlOutputMute' || type === 'wlMixVolume' || type === 'wlMixMute') {
        await ensureSeeded();
        const setVol = (type === 'wlOutputVolume' || type === 'wlMixVolume');
        const selector = (type === 'wlMixVolume' || type === 'wlMixMute') ? action.mixId : action.mix;
        const targets = resolveMixTargets(wlMixer.mixes, selector);
        if (!targets.length) return { ok: false, error: 'wl_unknown_mix' };
        const vol = setVol ? clampVolume(action.value) : null;
        if (setVol && vol == null) return { ok: false, error: 'bad_volume' };

        if (wlMixer.dialect === 3) {
          for (const mixId of targets) {
            const cur = wlMixer.mixes.find((m) => m.id === mixId) || {};
            // eslint-disable-next-line no-await-in-loop -- sequential by design: one call per mix
            await request('setMix', setVol ? { id: mixId, level: unitFromPct(vol) } : { id: mixId, isMuted: !cur.muted });
          }
        } else {
          wlMixer.outputRaw = wlMixer.outputRaw || {};
          for (const mixId of targets) {
            if (mixId === V2_MIX_LOCAL) { if (setVol) wlMixer.outputRaw.localVolumeOut = vol; else wlMixer.outputRaw.isLocalOutMuted = !wlMixer.outputRaw.isLocalOutMuted; }
            else { if (setVol) wlMixer.outputRaw.streamVolumeOut = vol; else wlMixer.outputRaw.isStreamOutMuted = !wlMixer.outputRaw.isStreamOutMuted; }
          }
          await pushV2Output();
        }
        return { ok: true };
      }

      // Per-channel effect chain (3.x only — 2.x has no effect list on the wire).
      if (type === 'wlEffect') {
        await ensureSeeded();
        if (wlMixer.dialect !== 3) return { ok: false, error: 'wl_unsupported' };
        const id = String(action.mixId == null ? '' : action.mixId);
        const ch = channels.get(id);
        if (!ch) return { ok: false, error: 'wl_unknown_channel' };
        const effectId = String(action.effectId == null ? '' : action.effectId);
        const eff = ch.effects.find((e) => e.id === effectId);
        if (!eff) return { ok: false, error: 'wl_unknown_effect' };
        const mode = String(action.mode || 'toggle').toLowerCase();
        const next = mode === 'on' ? true : mode === 'off' ? false : !eff.enabled;
        await request('setChannel', { id, effects: [{ id: effectId, isEnabled: next }] });
        return { ok: true };
      }

      // Switch which physical device the main output goes to (3.x only).
      if (type === 'wlOutputDevice') {
        await ensureSeeded();
        if (wlMixer.dialect !== 3) return { ok: false, error: 'wl_unsupported' };
        const deviceId = String(action.deviceId == null ? '' : action.deviceId);
        const dev = wlMixer.outputs.devices.find((d) => d.id === deviceId);
        if (!dev) return { ok: false, error: 'wl_unknown_device' };
        const outId = (dev.outputs[0] && dev.outputs[0].id) || deviceId;
        await request('setOutputDevice', { mainOutput: { outputDeviceId: deviceId, outputId: outId } });
        await refreshOutputs();
        return { ok: true };
      }

      // 2.x-only monitor controls. On 3.x the mixes ARE the monitoring model, so
      // there is nothing to flip; say unsupported rather than pretend.
      if (type === 'wlSwitchMonitoring') {
        await ensureSeeded();
        if (wlMixer.dialect === 3) return { ok: false, error: 'wl_unsupported' };
        const next = wlMixer.switchState === 'Stream Mix' ? 'Local Mix' : 'Stream Mix';
        const r = await request('switchMonitoring', { switchState: next }).catch(() => null);
        if (r && r.switchState != null) wlMixer.switchState = String(r.switchState);
        return { ok: true };
      }
      if (type === 'wlSetMonitorMix') {
        await ensureSeeded();
        if (wlMixer.dialect === 3) return { ok: false, error: 'wl_unsupported' };
        const mix = String(action.monitorMix == null ? '' : action.monitorMix).trim();
        if (!mix) return { ok: false, error: 'bad_monitor_mix' };
        const r = await request('setMonitorMixOutput', { monitorMix: mix }).catch(() => null);
        if (r && r.monitorMix != null) wlMixer.monitorMix = String(r.monitorMix);
        return { ok: true };
      }
      return { ok: false, error: 'bad_wl_action' };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'wl_failed' };
    }
  }

  return { runAction };
}

module.exports = { makeActions };
