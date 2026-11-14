'use strict';
// Whether this PC can run a local model: the memory each model needs, and a reading of this
// PC's memory and graphics memory.

const os = require('node:os');
const { execFile } = require('node:child_process');

// Minimum hardware each curated model can run on SAFELY, so we never hand a
// machine a model that will crash the GPU (CUDA illegal-access) or thrash it into
// an OOM. `minVramGB` = comfortable full-GPU offload; `minRamGB` = the slower but
// safe CPU-only fallback Ollama uses when the GPU can't hold the weights. These
// are the single source of truth for both auto-selection and the download gate.
// (12B sits at 12 GB, not 10 — a 12B model at 16k context OOMs a tight 10 GB card,
// which is exactly the crash this safety layer exists to prevent.)
const MODEL_REQUIREMENTS = Object.freeze({
  'qwen2.5:3b':  { minVramGB: 4,  minRamGB: 8 },
  'qwen2.5:7b':  { minVramGB: 6,  minRamGB: 16 },
  'llama3.1:8b': { minVramGB: 6,  minRamGB: 16 },
  'gemma4:12b':  { minVramGB: 12, minRamGB: 32 },
});

// Clamp a requirement pair that came from outside this file. Out-of-range or
// non-numeric values are dropped entirely rather than coerced: a requirement of
// 0 GB would wave through a model that cannot run, which is the one outcome this
// gate exists to prevent.
function _sanitizedReq(extra) {
  if (!extra || typeof extra !== 'object') return null;
  const v = Number(extra.minVramGB);
  const r = Number(extra.minRamGB);
  if (!Number.isFinite(v) || !Number.isFinite(r)) return null;
  if (v < 1 || v > 128 || r < 1 || r > 512) return null;
  return { minVramGB: v, minRamGB: r };
}

// Pure tier calculation from rounded GB figures. Mirrors the thresholds in the
// design spec §4.1, kept in lock-step with MODEL_REQUIREMENTS so `auto` never
// recommends a model the hardware can't run. Returns { tier, recommended }.
function computeTier({ ramGB = 0, vramGB = 0, cores = 0 } = {}) {
  if (vramGB >= 12) return { tier: 'optimal',     recommended: 'gemma4:12b' };
  if (ramGB >= 16 || vramGB >= 6) return { tier: 'recommended', recommended: 'qwen2.5:7b' };
  if (ramGB >= 8 || vramGB >= 4) return { tier: 'minimum',     recommended: 'qwen2.5:3b' };
  return { tier: 'incompatible', recommended: 'auto' };
}

// Can this concrete model run safely on the scanned hardware? Returns
// { ok, code, reason }. `code`: 'gpu' (fits VRAM), 'cpu' (fits RAM, slower),
// 'unknown' (custom tag we can't size — allowed, the tier gate still guards weak
// machines), or 'insufficient' (refuse — neither VRAM nor RAM is enough). The
// reason string is user-facing Italian, shown verbatim when a download is blocked.
// `extraReq` carries the requirements the remote download catalog published for
// a model this table does not know ({ minVramGB, minRamGB }). The LOCAL table
// always wins where it has an entry: it is the safety gate, and a file fetched
// over the network must not be able to lower the bar on a machine it cannot see.
function modelSafety(model, scan, extraReq) {
  const s = scan || {};
  const vram = Number(s.vram) || 0;
  const ram = Number(s.ram) || 0;
  const req = MODEL_REQUIREMENTS[model] || _sanitizedReq(extraReq);
  if (!req) return { ok: true, code: 'unknown', reason: '' };
  if (vram >= req.minVramGB) return { ok: true, code: 'gpu', reason: '' };
  if (ram >= req.minRamGB) return { ok: true, code: 'cpu', reason: '' };
  return {
    ok: false,
    code: 'insufficient',
    reason: `Il modello «${model}» richiede circa ${req.minVramGB} GB di memoria video `
      + `(oppure ${req.minRamGB} GB di RAM per la modalità CPU). Il tuo hardware ha `
      + `${vram} GB di VRAM e ${ram} GB di RAM: non è sufficiente per eseguirlo in sicurezza. `
      + `Scegli un modello più leggero o usa Xenon AI in cloud (Gemini).`,
  };
}

// Best-effort GPU VRAM in GB via WMI AdapterRAM (32-bit, capped at 4 GB) with a
// registry fallback for cards >4 GB (HardwareInformation.qwMemorySize). Returns
// 0 when no dedicated GPU info is available — the scan then relies on RAM only.
function _readGpuVramGB(timeoutMs = 6000) {
  // Apple Silicon has no dedicated VRAM to report: the GPU addresses system
  // memory, so 0 here is the honest answer AND the useful one — computeTier then
  // sizes the model from RAM, which is exactly what the GPU can use. Returning
  // early also avoids spawning a powershell.exe that cannot exist.
  if (process.platform !== 'win32') return Promise.resolve(0);
  return new Promise((resolve) => {
    const ps = [
      '$ErrorActionPreference="SilentlyContinue";',
      '$best=0;',
      // Registry holds true VRAM for modern GPUs (qwMemorySize, 64-bit).
      '$keys=Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" -EA SilentlyContinue;',
      'foreach($k in $keys){ $v=(Get-ItemProperty $k.PSPath -Name "HardwareInformation.qwMemorySize" -EA SilentlyContinue)."HardwareInformation.qwMemorySize"; if($v -and $v -gt $best){$best=$v} }',
      'if($best -le 0){ $g=Get-CimInstance Win32_VideoController -EA SilentlyContinue | Sort-Object AdapterRAM -Descending | Select-Object -First 1; if($g){$best=$g.AdapterRAM} }',
      'Write-Output $best',
    ].join(' ');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve(0);
        const bytes = Number(String(stdout).trim()) || 0;
        resolve(bytes > 0 ? Math.round(bytes / (1024 ** 3)) : 0);
      });
  });
}

// Full hardware probe: RAM from os, cores from os, VRAM from PowerShell. Returns
// { ram, vram, cores, tier, recommended } with GB rounded down for RAM (so a
// "16 GB" stick reading 15.9 still counts as 16 via Math.round).
async function scanHardware() {
  const ramGB = Math.round(os.totalmem() / (1024 ** 3));
  const cores = os.cpus() ? os.cpus().length : 0;
  const vramGB = await _readGpuVramGB();
  const { tier, recommended } = computeTier({ ramGB, vramGB, cores });
  return { ram: ramGB, vram: vramGB, cores, tier, recommended };
}

module.exports = {
  MODEL_REQUIREMENTS, _sanitizedReq, computeTier, modelSafety, _readGpuVramGB, scanHardware,
};
