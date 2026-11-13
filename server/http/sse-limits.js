// Limits of the live event streams to the dashboards: unsent data per stream, and streams per
// device.

// A stream whose reader has stopped reading keeps every event in memory. Past
// this much unsent data it is dropped (the page reconnects on its own when it
// is alive), so one stuck or hostile client cannot grow the server without end.
const SSE_MAX_BUFFERED = 1024 * 1024;
const SSE_MAX_PER_DEVICE = 4;

module.exports = { SSE_MAX_BUFFERED, SSE_MAX_PER_DEVICE };
