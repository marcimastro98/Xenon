// Names and models of the drives, asked rarely and kept: the two slow questions, their answers,
// and when each is asked again.

const {
  DISK_DETAILS_TIMEOUT_MS, DISK_DETAILS_BG_TIMEOUT_MS, DISK_MODELS_TIMEOUT_MS, diskProbeFresh,
} = require('./details-timings.js');
const { VOLUME_DETAILS_COMMAND, DISK_MODELS_COMMAND } = require('./details-commands.js');
const { psRows, joinDiskDetails } = require('./details-shape.js');
const { runPowerShellCommand } = require('../powershell/run-command.js');

const volumeDetailsProbe = { data: null, updatedAt: 0, ok: false, pending: null };
const diskModelsProbe = { data: null, updatedAt: 0, ok: false, pending: null };

// Shared by both probes. `parse` returns { map, ok }: `ok` is whether the query
// answered at all, which is not the same as whether the map has entries (a PC
// whose disks report no friendly name answers correctly with nothing to show,
// and must not be re-asked every minute forever).
function runDiskProbe(probe, command, timeout, parse) {
  if (probe.pending) return probe.pending;
  probe.pending = (async () => {
    try {
      const { map, ok } = parse(await runPowerShellCommand(command, timeout));
      // Volumes and disks change on plug/unplug and nothing else, so details we
      // already have are always better than none: a read that answered nothing
      // is recorded as a failed one (short TTL, retried) and never replaces a
      // map that had drives in it.
      const keep = (ok || !probe.ok) ? map : probe.data;
      Object.assign(probe, { data: keep, updatedAt: Date.now(), ok });
      return keep;
    } catch {
      const keep = probe.ok ? probe.data : {};
      Object.assign(probe, { data: keep, updatedAt: Date.now(), ok: false });
      return keep;
    } finally {
      probe.pending = null;
    }
  })();
  return probe.pending;
}

function refreshVolumeDetails(timeout) {
  return runDiskProbe(volumeDetailsProbe, VOLUME_DETAILS_COMMAND, timeout, data => {
    const map = {};
    const rows = psRows(data.volumes);
    rows.forEach(volume => {
      if (volume && volume.drive) map[String(volume.drive).toUpperCase()] = volume;
    });
    return { map, ok: rows.length > 0 };
  });
}

function refreshDiskModels(timeout) {
  return runDiskProbe(diskModelsProbe, DISK_MODELS_COMMAND, timeout, data => {
    const map = {};
    const rows = psRows(data.models);
    rows.forEach(row => {
      const model = row && row.drive ? String(row.model || '').trim() : '';
      if (model) map[String(row.drive).toUpperCase()] = model;
    });
    return { map, ok: rows.length > 0 };
  });
}

async function getDiskDetails() {
  // Started first so it is already in flight while the volumes read blocks, and
  // never awaited: nothing on screen waits for the name of a disk.
  const models = diskModels();
  return joinDiskDetails(await volumeDetails(), models);
}

function volumeDetails() {
  if (diskProbeFresh(volumeDetailsProbe)) return volumeDetailsProbe.data;
  // Nothing cached at all: this is the first read of the process, so wait for it
  // rather than paint the disk card with no detail line and fill it in later.
  if (!volumeDetailsProbe.data) return refreshVolumeDetails(DISK_DETAILS_TIMEOUT_MS);
  refreshVolumeDetails(DISK_DETAILS_BG_TIMEOUT_MS);   // lands on the next cycle
  return volumeDetailsProbe.data;
}

// Synchronous by design — see DISK_MODELS_TIMEOUT_MS. A stale or missing map
// starts a refresh that lands on a later cycle; runDiskProbe swallows its own
// failures, so the unawaited promise can never reject.
function diskModels() {
  if (!diskProbeFresh(diskModelsProbe)) refreshDiskModels(DISK_MODELS_TIMEOUT_MS);
  return diskModelsProbe.data || {};
}

module.exports = {
  volumeDetailsProbe, diskModelsProbe, runDiskProbe, refreshVolumeDetails, refreshDiskModels,
  getDiskDetails, volumeDetails, diskModels,
};
