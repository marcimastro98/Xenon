// Reads what each disk reads and writes per second, from two readings of its counters, one
// reading at a time.

const { nativeCollectors } = require('./native-collectors.js');
const { DISK_IO_SCRIPT } = require('./script-paths.js');
const { runCollector } = require('./pwsh-worker.js');
const { bytesPerSec, DISK_SECTOR } = require('./rates.js');
const { diskIo } = require('./disk-io-state.js');

function getDiskIo() {
  if (diskIo.pending) return diskIo.pending;
  diskIo.pending = _getDiskIoRaw().finally(() => { diskIo.pending = null; });
  return diskIo.pending;
}

async function _getDiskIoRaw() {
  let rows = [];
  try {
    if (nativeCollectors) {
      rows = await nativeCollectors.diskIo();
    } else {
      const out = await runCollector(DISK_IO_SCRIPT, [], 8000);
      rows = (out && Array.isArray(out.disks)) ? out.disks : [];
    }
  } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];

  const now = Date.now();
  const seen = new Set();
  const disks = [];
  for (const d of rows) {
    const id = String((d && d.id) || '').slice(0, 120);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Linux counts sectors, Windows and macOS count bytes. Normalise here so
    // the SDK sees one unit and nobody has to know which OS answered.
    const rb = Number.isFinite(Number(d.readBytes)) ? Number(d.readBytes)
      : (Number(d.sectorsRead) || 0) * DISK_SECTOR;
    const wb = Number.isFinite(Number(d.writeBytes)) ? Number(d.writeBytes)
      : (Number(d.sectorsWritten) || 0) * DISK_SECTOR;
    const ro = Number(d.readsCompleted) || 0;
    const wo = Number(d.writesCompleted) || 0;
    const prev = diskIo.prev.get(id);
    const dt = prev ? (now - prev.t) / 1000 : 0;
    disks.push({
      id,
      model: String((d && d.model) || id).slice(0, 120),
      serial: String((d && d.serial) || '').slice(0, 80),
      kind: d && (d.kind === 'ssd' || d.kind === 'hdd') ? d.kind : '',
      sizeBytes: Number.isFinite(Number(d.sizeBytes)) && Number(d.sizeBytes) > 0 ? Number(d.sizeBytes) : null,
      volumes: Array.isArray(d.volumes) ? d.volumes.slice(0, 16).map((v) => ({
        mount: String((v && v.mount) || '').slice(0, 160),
        label: String((v && v.label) || '').slice(0, 80),
        fstype: String((v && v.fstype) || '').slice(0, 24),
      })) : [],
      temperature: Number.isFinite(Number(d && d.temperature)) ? Number(d.temperature) : null,
      readBytesPerSec: bytesPerSec(rb, prev && prev.rb, dt),
      writeBytesPerSec: bytesPerSec(wb, prev && prev.wb, dt),
      readIops: bytesPerSec(ro, prev && prev.ro, dt),
      writeIops: bytesPerSec(wo, prev && prev.wo, dt),
      readBytes: rb,
      writeBytes: wb,
    });
    diskIo.prev.set(id, { rb, wb, ro, wo, t: now });
  }
  for (const id of Array.from(diskIo.prev.keys())) {
    if (!seen.has(id)) diskIo.prev.delete(id);
  }
  return { ok: true, disks };
}

module.exports = { getDiskIo, _getDiskIoRaw };
