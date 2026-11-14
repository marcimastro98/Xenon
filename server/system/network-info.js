// The network reading the dashboard shows: the adapter, its address, the speed up and down, the
// ping and the share of lost packets; two dashboards asking together share one reading.

const { nativeCollectors } = require('./native-collectors.js');
const fpsMonitor = require('../fps-monitor.js');
const { NETWORK_FRESH_MS } = require('./timings.js');
const { NETWORK_SCRIPT } = require('./script-paths.js');
const { runCollector } = require('./pwsh-worker.js');
const { netReadings } = require('./network-state.js');
const { _packetLoss } = require('./packet-loss-count.js');
const { bytesPerSec } = require('./rates.js');

async function getNetworkInfo() {
  if (netReadings.last && Date.now() - netReadings.last.at < NETWORK_FRESH_MS) return netReadings.last.reading;
  // In-flight dedup: with two dashboards open the 3s polls interleave, and two
  // concurrent runs would both rewrite netReadings.prev — corrupting the bandwidth
  // delta — while doubling the collector work. Latecomers share the result.
  if (netReadings.pending) return netReadings.pending;
  netReadings.pending = _getNetworkInfoRaw()
    .then((reading) => { netReadings.last = { at: Date.now(), reading }; return reading; })
    .finally(() => { netReadings.pending = null; });
  return netReadings.pending;
}
async function _getNetworkInfoRaw() {
  // PresentMon's FPS wins anyway when it is available, so tell the collector to
  // skip its own FPS sampling — the DWM fallback sleeps 600ms inside the serial
  // worker, delaying every other queued sensor read.
  let skipFps = false;
  try { skipFps = fpsMonitor.isAvailable(); } catch { skipFps = false; }
  const data = nativeCollectors ? await nativeCollectors.network() : await runCollector(NETWORK_SCRIPT, skipFps ? ['-SkipFps'] : [], 8000);
  _packetLoss.add(data.pingSent, data.pingLost);
  const now = Date.now();
  const rx = Number(data.rxBytes) || 0;
  const tx = Number(data.txBytes) || 0;

  let downBps = null, upBps = null;
  if (netReadings.prev && now > netReadings.prev.t) {
    const dt = (now - netReadings.prev.t) / 1000; // seconds
    const dRx = rx - netReadings.prev.rx;
    const dTx = tx - netReadings.prev.tx;
    if (dt > 0 && dRx >= 0 && dTx >= 0) {
      downBps = Math.round(dRx / dt);
      upBps   = Math.round(dTx / dt);
    }
  }
  netReadings.prev = { rx, tx, t: now };

  // Per-interface throughput, the same delta one level down. Asked for on
  // Discord by someone building a monitoring widget who wants his NAS link, his
  // internet link and a VMware VMnet on separate graphs: the collectors have
  // always read each adapter and thrown the breakdown away at the sum.
  //
  // Each interface keeps its OWN timestamp, so one that appears mid-session
  // reports null until it has two readings of its own rather than inheriting
  // the totals' clock and printing a spike the size of its lifetime counter.
  const interfaces = [];
  const seenIds = new Set();
  for (const n of (Array.isArray(data.interfaces) ? data.interfaces : [])) {
    const id = String((n && n.id) || '').slice(0, 120);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const nrx = Number(n.rxBytes) || 0;
    const ntx = Number(n.txBytes) || 0;
    const prev = netReadings.prevIfaces.get(id);
    const dt = prev ? (now - prev.t) / 1000 : 0;
    interfaces.push({
      id,
      // The name the user sees and renames in Windows; the collectors fall back
      // to the system id where the platform has no separate display name.
      name: String((n && n.name) || id).slice(0, 120),
      description: String((n && n.description) || '').slice(0, 160),
      kind: n && n.kind === 'virtual' ? 'virtual' : 'physical',
      up: n && typeof n.up === 'boolean' ? n.up : null,
      speedBps: Number.isFinite(Number(n && n.speedBps)) && Number(n.speedBps) > 0 ? Number(n.speedBps) : null,
      rxBytesPerSec: bytesPerSec(nrx, prev && prev.rx, dt),
      txBytesPerSec: bytesPerSec(ntx, prev && prev.tx, dt),
      rxBytes: nrx,
      txBytes: ntx,
    });
    netReadings.prevIfaces.set(id, { rx: nrx, tx: ntx, t: now });
  }
  // Forget adapters that are gone, so the map tracks the machine rather than
  // its history.
  for (const id of Array.from(netReadings.prevIfaces.keys())) {
    if (!seenIds.has(id)) netReadings.prevIfaces.delete(id);
  }

  // Prefer PresentMon's real in-game FPS (works in exclusive fullscreen);
  // fall back to the PowerShell DWM/LHM reading when it isn't available.
  //
  // `fps` is the frame rate the person is SEEING — display-side where the
  // capture carries it. `presentFps` and `displayFps` are the two halves, which
  // frame generation pulls apart: with DLSS FG at x2 one game presented 223
  // frames a second and displayed 152, and every other overlay on the screen
  // said ~155. Either half can be null on its own (the DWM fallback and MangoHud
  // report one number, not two), and a widget should draw `fps` unless it
  // specifically wants to show the difference.
  let detail = null;
  try { detail = fpsMonitor.getFpsDetail(); } catch { detail = null; }
  let fps = detail ? detail.fps : null;
  if (fps == null) fps = data.fps ?? null;

  return {
    ping: data.ping ?? null,
    latency: data.latency ?? null,
    // Share of the newest echoes to 1.1.1.1 that never came back (packet-loss.js).
    loss: _packetLoss.percent(),
    fps,
    presentFps: (detail && detail.presentFps != null) ? detail.presentFps : null,
    displayFps: (detail && detail.displayFps != null) ? detail.displayFps : null,
    gpuLatency: data.gpuLatency ?? null,
    downloadBps: downBps,
    uploadBps: upBps,
    // Every adapter the machine has, physical and virtual, each with its own
    // throughput. `downloadBps`/`uploadBps` above stay the sum of the PHYSICAL
    // ones and are what the Network tile draws: adding a VPN or a VMnet to that
    // total would count the same packets twice.
    interfaces,
  };
}

module.exports = { getNetworkInfo, _getNetworkInfoRaw };
