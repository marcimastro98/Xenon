// How often the full sensor list is read for the widgets that asked for it.

// ── SDK `sensors` stream ────────────────────────────────────────────────────
// The whole sensor catalog (collectSensors) for widgets that want the AIO's
// liquid, a VRM or one fan by name. Demand-gated like `processes`: nothing
// runs unless a package holds the grant and a surface is connected, and a tick
// still running skips the next one rather than queueing behind the worker.
// Slower than `processes` on purpose: on an NVIDIA card a catalog read may
// refresh the GPU through LHM (60-80 ms, at most every 2 s, see sensors.ps1).
const SENSORS_STREAM_POLL_MS = 3000;

module.exports = { SENSORS_STREAM_POLL_MS };
