// The long-lived PowerShell worker as the engine holds it: the process, what it is still
// answering, and how its pending requests are failed when it goes.

const _worker = { proc: null, buf: '', nextId: 1, pending: new Map() };

function _workerReject(id, err) {
  const p = _worker.pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  _worker.pending.delete(id);
  p.reject(err);
}

function _killWorker(reason) {
  const proc = _worker.proc;
  _worker.proc = null;
  _worker.buf = '';
  for (const id of [..._worker.pending.keys()]) _workerReject(id, new Error(reason || 'worker down'));
  if (proc) { try { proc.kill(); } catch {} }
}

module.exports = { _worker, _workerReject, _killWorker };
