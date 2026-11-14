'use strict';
// One line of /proc/<pid>/stat read into the name, the processor time and the memory of a
// process.

// --- Per-process CPU/RAM for the `processes` stream -------------------------
// One read of /proc/<pid>/stat per process carries BOTH the cumulative CPU time
// and the resident set, so this needs no external tool and no second file.
//
// Per-process GPU is deliberately absent rather than approximated. It exists on
// Linux only through DRM fdinfo (i915/amdgpu, recent kernels) or `nvidia-smi
// pmon`, each covering one vendor and neither covering a hybrid laptop
// correctly. `gpuAvail: false` makes the widget hide the column and say why,
// which is the honest answer; a column of zeros would read as "nothing is using
// the GPU" and be worse than no column at all.
//
// /proc/[pid]/stat fields are 1-indexed in proc(5). comm (field 2) is wrapped in
// parentheses AND may itself contain spaces and parentheses — "((sd-pam))" is
// real — so it is cut at the LAST ')' rather than tokenised.
const USER_HZ = 100;   // fixed by the kernel ABI for /proc/[pid]/stat, not by CONFIG_HZ

function parseProcStat(text) {
  const line = String(text || '').trim();
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(line.slice(0, open).trim());
  const name = line.slice(open + 1, close);
  if (!Number.isInteger(pid) || pid <= 0 || !name) return null;
  // After the closing paren the first token is field 3 (state), so field N sits
  // at index N-3: ppid=4 -> 1, utime=14 -> 11, stime=15 -> 12, starttime=22 -> 19, rss=24 -> 21.
  const rest = line.slice(close + 1).trim().split(/\s+/);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return {
    pid,
    ppid: Number(rest[1]) || 0,
    name,
    startTicks: Number(rest[19]) || 0,
    cpuMs: ((utime + stime) / USER_HZ) * 1000,
    rssPages: Number.isFinite(rssPages) && rssPages > 0 ? rssPages : 0,
  };
}

module.exports = { USER_HZ, parseProcStat };
