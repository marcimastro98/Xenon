'use strict';
// What is read from the Wave Link client: the channels, the mixes, a channel's icon, the state
// the tile shows, whether there is a connection, and the connection tried.

function makeReads({ wlLink, wlMixer, channels, icons, meters, seedState, ensureSeeded, connect }) {
  // Channel list for the editor's picker: [{ value, label }].
  async function listChannels() {
    await ensureSeeded();
    return Array.from(channels.values())
      .map((ch) => ({ value: ch.id, label: ch.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  // Mix list for the editor's picker. On 2.x these are the two synthetic mixes,
  // so the same key works on both dialects and the user sees words rather than
  // ids either way.
  async function listMixes() {
    await ensureSeeded();
    return wlMixer.mixes.map((m) => ({ value: m.id, label: m.name }));
  }

  // The channel artwork 3.x ships as base64. Served on demand by URL so it never
  // rides the SSE frame.
  function iconFor(id) {
    const data = icons.get(String(id || ''));
    if (!data) return null;
    try { return Buffer.from(data, 'base64'); } catch (e) { return null; }
  }

  function snapshot() {
    const list = [];
    for (const ch of channels.values()) {
      const meter = meters.get('channel:' + ch.id) || null;
      list.push(Object.assign({}, ch, { meter }));
    }
    return {
      connected: !!wlLink.ws,
      dialect: wlMixer.dialect,
      version: wlMixer.identity ? wlMixer.identity.version : '',
      channels: list,
      mixes: wlMixer.mixes.map((m) => Object.assign({}, m, { meter: meters.get('mix:' + m.id) || null })),
      outputs: wlMixer.outputs,
      // 2.x-only; the widget hides the control when these are absent.
      monitor: wlMixer.dialect === 2 ? { monitorMix: wlMixer.monitorMix, switchState: wlMixer.switchState, micConnected: wlMixer.micConnected } : null,
      capabilities: {
        meters: wlMixer.dialect === 3,
        effects: wlMixer.dialect === 3,
        outputDevices: wlMixer.dialect === 3,
        monitorSwitch: wlMixer.dialect === 2,
        namedMixes: wlMixer.dialect === 3,
      },
    };
  }

  function isConnected() { return !!wlLink.ws; }

  async function test() {
    try {
      await connect();
      if (!wlMixer.seeded) await seedState();
      return { ok: true, count: channels.size, dialect: wlMixer.dialect, version: wlMixer.identity ? wlMixer.identity.version : '' };
    } catch (e) { return { ok: false, error: (e && e.message) || 'wl_connect_failed' }; }
  }

  return { listChannels, listMixes, iconFor, snapshot, isConnected, test };
}

module.exports = { makeReads };
