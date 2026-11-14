'use strict';
// Reading the whole mixer from Wave Link: the channels, the outputs and the mixes of either
// dialect, the levels asked for, and the connection held open and read again while somebody
// watches.

const { PING_MS } = require('./wavelink-ports.js');
const { v2Mixes, adaptV3Mixes, adaptV3Outputs } = require('./wavelink-shape.js');

function makeSeed({
  wlLink, wlMixer, v3MixRaw, channels, meters, ingestV2Channels, ingestV3Channels, clearPing,
  scheduleReconnect, notify, connect, request,
}) {
  // ── seeding ────────────────────────────────────────────────────────────────
  async function refreshChannels() {
    if (wlMixer.dialect === 3) {
      const r = await request('getChannels').catch(() => null);
      ingestV3Channels(r && r.channels);
    } else {
      const r = await request('getAllChannelInfo').catch(() => null);
      ingestV2Channels(r);
    }
  }

  async function refreshOutputs() {
    if (wlMixer.dialect !== 3) return;
    const r = await request('getOutputDevices').catch(() => null);
    wlMixer.outputs = adaptV3Outputs(r);
  }

  async function seedState() {
    if (wlMixer.dialect === 3) {
      const [chans, mixList, outs] = await Promise.all([
        request('getChannels').catch(() => null),
        request('getMixes').catch(() => null),
        request('getOutputDevices').catch(() => null),
      ]);
      ingestV3Channels(chans && chans.channels);
      v3MixRaw.clear();
      for (const m of (mixList && Array.isArray(mixList.mixes)) ? mixList.mixes : []) if (m && m.id != null) v3MixRaw.set(String(m.id), m);
      wlMixer.mixes = adaptV3Mixes(mixList && mixList.mixes);
      wlMixer.outputs = adaptV3Outputs(outs);
    } else {
      const [chans, monitoring, sw, mm, mic] = await Promise.all([
        request('getAllChannelInfo').catch(() => null),
        request('getMonitoringState').catch(() => null),
        request('getSwitchState').catch(() => null),
        request('getMonitorMixOutputList').catch(() => null),
        request('getMicrophoneState').catch(() => null),
      ]);
      ingestV2Channels(chans);
      wlMixer.mixes = v2Mixes();
      if (monitoring && typeof monitoring === 'object') wlMixer.outputRaw = monitoring;
      if (sw && sw.switchState != null) wlMixer.switchState = String(sw.switchState);
      if (mm && mm.monitorMix != null) wlMixer.monitorMix = String(mm.monitorMix);
      if (mic) wlMixer.micConnected = !!mic.isMicrophoneConnected;
      // The 2.x output mixer is the master of the two synthetic mixes.
      if (wlMixer.outputRaw) {
        wlMixer.mixes[0].level = Number.isFinite(wlMixer.outputRaw.localVolumeOut) ? wlMixer.outputRaw.localVolumeOut : 0;
        wlMixer.mixes[0].muted = !!wlMixer.outputRaw.isLocalOutMuted;
        wlMixer.mixes[1].level = Number.isFinite(wlMixer.outputRaw.streamVolumeOut) ? wlMixer.outputRaw.streamVolumeOut : 0;
        wlMixer.mixes[1].muted = !!wlMixer.outputRaw.isStreamOutMuted;
      }
    }
    wlMixer.seeded = true;
  }

  // ── level meters (3.x only) ────────────────────────────────────────────────
  //
  // Meters are OFF until asked for, one subscription per target, and they are
  // turned off again on teardown. Leaving them on would keep Wave Link pushing
  // at a dashboard nobody is looking at, which is the same "periodic work with
  // no listener" this codebase gates everywhere else.
  async function setMeters(on) {
    if (wlMixer.dialect !== 3) return { ok: true };
    const wanted = [];
    if (on) {
      for (const ch of channels.values()) wanted.push({ id: ch.id, type: 'channel' });
      for (const m of wlMixer.mixes) wanted.push({ id: m.id, type: 'mix' });
    }
    const key = (s) => s.type + ':' + s.id;
    const have = new Set(wlMixer.meterSubs.map(key));
    const want = new Set(wanted.map(key));
    for (const s of wlMixer.meterSubs) {
      if (want.has(key(s))) continue;
      // eslint-disable-next-line no-await-in-loop -- sequential by design: one small call each
      await request('setSubscription', { levelMeterChanged: { id: s.id, subId: '', type: s.type, isEnabled: false } }).catch(() => {});
      meters.delete(key(s));
    }
    for (const s of wanted) {
      if (have.has(key(s))) continue;
      // eslint-disable-next-line no-await-in-loop -- same
      await request('setSubscription', { levelMeterChanged: { id: s.id, subId: '', type: s.type, isEnabled: true } }).catch(() => {});
    }
    wlMixer.meterSubs = wanted;
    return { ok: true };
  }

  async function seedAndHold() {
    await seedState();
    clearPing();
    wlLink.pingTimer = setInterval(() => {
      request('getApplicationInfo').catch(() => { if (wlLink.watching && wlLink.ws) { try { wlLink.ws.close(); } catch (e) {} } });
    }, PING_MS);
    if (wlMixer.wantMeters) await setMeters(true).catch(() => {});
    notify();
  }

  function startWatchConn() {
    connect().then(seedAndHold).catch(() => scheduleReconnect());
  }

  async function ensureSeeded() { if (!wlMixer.seeded || !wlLink.ws) { await connect(); if (!wlMixer.seeded) await seedState(); } }

  return { refreshChannels, refreshOutputs, seedState, setMeters, startWatchConn, ensureSeeded };
}

module.exports = { makeSeed };
