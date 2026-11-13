// Paints the processor, graphics, memory and disk readings into the system tiles, and turns
// temperatures into the unit chosen.
'use strict';

// The server's first answer after a start: its slow readings are still out, so a
// missing detail says nothing yet about the machine.
let systemAnswerPartial = false;

// Scoped field lookup within one System instance root.
function sf(root, name) { return root.querySelector('[data-sf="' + name + '"]'); }

function cycleDisk() {
  if (!systemDisks || systemDisks.length < 2) return;
  diskIndex = (diskIndex + 1) % systemDisks.length;
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => renderDiskInto(root, systemDisks[diskIndex]));
  }
}

// Flip the GPU card between load % and VRAM %. The two series are unrelated, so
// clear the sparkline history first — otherwise the graph would splice load and
// memory into one line. Re-renders from the cached payload for instant feedback.
function cycleGpuMetric() {
  gpuMetric = gpuMetric === 'vram' ? 'load' : 'vram';
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => resetStatSparkFor(sf(root, 'gpu-fill')));
  }
  if (lastSystemData) applySystem(lastSystemData);
}

function renderDiskInto(root, disk) {
  const label = sf(root, 'disk-label'), value = sf(root, 'disk-value'),
        small = sf(root, 'disk-small'), sub = sf(root, 'disk-sub'),
        detail = sf(root, 'disk-detail'), fill = sf(root, 'disk-fill');
  if (!disk) {
    if (label) label.textContent = t('disk_label');
    if (value) value.textContent = '--%';
    if (small) small.textContent = '';
    if (sub) sub.textContent = '--';
    if (detail) detail.textContent = '--';
    if (fill) setFill(fill, 0);
    return;
  }
  if (label) label.textContent = `${t('disk_label')} ${disk.drive}`;
  if (value) value.textContent = disk.percent + '%';
  if (small) small.textContent = formatBytes(disk.free) + ' ' + t('gb_free');
  if (sub) sub.textContent = formatBytes(disk.used) + ' / ' + formatBytes(disk.total);
  if (detail) {
    // Most Windows volumes carry no label at all, which left this line reading
    // "NTFS - Fixed". The disk's own name is the better answer when there is no
    // label, and it is what people expect to see under a drive.
    const parts = [disk.label || disk.model, disk.fileSystem, disk.driveType]
      .map(p => String(p || '').trim()).filter(Boolean);
    detail.textContent = parts.length ? parts.join(' - ') : (systemAnswerPartial ? '--' : t('disk_detail_unavailable'));
  }
  if (fill) setFill(fill, disk.percent);
}

// Back-compat: render the "current" disk into every instance.
function renderDisk(disk) {
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => renderDiskInto(root, disk));
  }
}

// Shorten a raw CPU/GPU model string for the compact header line next to the
// CPU/GPU label — drop marketing noise (®/™, "Processor", "N-Core", "GeForce",
// "with Radeon Graphics") and collapse spaces so it reads like "Ryzen 7 7800X3D"
// or "NVIDIA RTX 5080". CSS ellipsis handles whatever still overflows.
function shortHwName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === '--') return '';
  return s
    .replace(/\((?:R|TM)\)/gi, '')
    .replace(/[®™]/g, '')
    .replace(/\b\d+\s*-?\s*Core\b/gi, '')
    .replace(/\bProcessor\b/gi, '')
    .replace(/\bGeForce\b/gi, '')
    .replace(/\bwith\s+Radeon\s+Graphics\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function applySystemInto(root, data) {
  const set = (name, text) => { const el = sf(root, name); if (el) el.textContent = text; };
  const fillEl = (name, pct) => { const el = sf(root, name); if (el) setFill(el, pct); };

  set('host-name', data.hostname || 'Local cockpit');
  set('uptime-text', `${t('uptime_prefix')} ${formatUptime(data.uptime)}`);

  const cpu = Number.isFinite(data.cpu) ? data.cpu : 0;
  set('cpu-value', cpu + '%'); fillEl('cpu-fill', cpu); set('cpu-name', data.cpuName || '--');
  set('cpu-name-head', shortHwName(data.cpuName));
  const cpuTemp = Number(data.cpuTemp);
  set('cpu-head-temp', (Number.isFinite(cpuTemp) && cpuTemp > 0) ? toDisplayHwTemp(cpuTemp) + '°' + hwTempUnitSuffix() : '');

  const ram = data.memory ? data.memory.percent : 0;
  set('ram-value', ram + '%');
  set('ram-small', data.memory ? formatBytes(data.memory.total) : '');
  fillEl('ram-fill', ram);
  set('ram-sub', data.memory ? formatBytes(data.memory.used) + ' / ' + formatBytes(data.memory.total) : '--');
  const ramDetail = data.ramDetail || {};
  set('ram-detail', ramDetail.detail || data.ramName || (systemAnswerPartial ? '--' : t('ram_detail_unavailable')));
  set('ram-name', ramDetail.moduleName || '');

  // The GPU card shows either load % or VRAM % (tap the ⇄ toggle). VRAM only
  // exists when the sensor reported it (nvidia-smi / LHM); otherwise the toggle
  // stays hidden and the card is pinned to load, so nothing regresses on GPUs
  // that don't expose dedicated memory.
  const vramUsed = Number(data.vramUsed), vramTotal = Number(data.vramTotal);
  const hasVram = Number.isFinite(vramTotal) && vramTotal > 0 && Number.isFinite(vramUsed) && vramUsed >= 0;
  const showVram = hasVram && gpuMetric === 'vram';
  set('gpu-metric-label', showVram ? 'VRAM' : 'GPU');

  if (showVram) {
    const vramPct = Math.round((vramUsed / vramTotal) * 100);
    set('gpu-value', vramPct + '%'); fillEl('gpu-fill', vramPct);
    set('gpu-vram-detail', `${formatBytes(vramUsed)} / ${formatBytes(vramTotal)}`);
  } else if (data.gpu === null || data.gpu === undefined) {
    set('gpu-value', '--%'); fillEl('gpu-fill', 0);
    set('gpu-vram-detail', '');
  } else {
    set('gpu-value', data.gpu + '%'); fillEl('gpu-fill', data.gpu);
    set('gpu-vram-detail', '');
  }
  const metricBtn = sf(root, 'gpu-metric-btn');
  if (metricBtn) metricBtn.style.display = hasVram ? '' : 'none';

  set('gpu-name', data.gpuName || t('gpu_loading'));
  set('gpu-name-head', shortHwName(data.gpuName));
  const gpuTemp = Number(data.gpuTemp);
  set('gpu-head-temp', (Number.isFinite(gpuTemp) && gpuTemp > 0) ? toDisplayHwTemp(gpuTemp) + '°' + hwTempUnitSuffix() : '');

  if (data.disks && data.disks.length > 0) {
    systemDisks = data.disks;
    if (diskIndex >= systemDisks.length) diskIndex = 0;
    renderDiskInto(root, systemDisks[diskIndex]);
    const cycleBtn = sf(root, 'disk-cycle-btn');
    if (cycleBtn) cycleBtn.style.display = systemDisks.length > 1 ? '' : 'none';
  } else {
    systemDisks = null;
    renderDiskInto(root, null);
    const cycleBtn = sf(root, 'disk-cycle-btn');
    if (cycleBtn) cycleBtn.style.display = 'none';
  }
}

function applySystem(data) {
  // The two answers can cross on the way in: a full one is never replaced by a partial.
  if (data.partial && lastSystemData && !lastSystemData.partial) return;
  systemAnswerPartial = !!data.partial;
  lastSystemData = data;
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => applySystemInto(root, data));
  }
}

// EVERY temperature inside Xenon is Celsius — the weather API, the hardware
// collectors, Guardian's alert thresholds, the briefing history. Only the
// display converts, against client-side preferences (hubSettings.tempUnit and
// hubSettings.hwTempUnit), so switching the unit needs no re-fetch and no stored
// value is ever ambiguous.
// Returns null/'' unchanged so callers' "--" placeholder still works.
function convertTemp(celsius, fahrenheit) {
  if (celsius === null || celsius === undefined || celsius === '') return celsius;
  const c = Number(celsius);
  if (!Number.isFinite(c)) return celsius;
  return Math.round(fahrenheit ? c * 9 / 5 + 32 : c);
}
function weatherTempIsF() {
  return typeof hubSettings === 'object' && hubSettings && hubSettings.tempUnit === 'f';
}
// Hardware readings (CPU/GPU headers, Guardian, the briefing) can have their own
// unit: some people read the forecast in °F and their CPU in °C. 'auto' follows
// the weather unit, so nobody who never touches it sees a change.
function hwTempIsF() {
  const hs = typeof hubSettings === 'object' && hubSettings ? hubSettings : {};
  return hs.hwTempUnit === 'f' || hs.hwTempUnit === 'c' ? hs.hwTempUnit === 'f' : hs.tempUnit === 'f';
}
function toDisplayTemp(celsius) { return convertTemp(celsius, weatherTempIsF()); }
function tempUnitSuffix() { return weatherTempIsF() ? 'F' : 'C'; }
function toDisplayHwTemp(celsius) { return convertTemp(celsius, hwTempIsF()); }
function hwTempUnitSuffix() { return hwTempIsF() ? 'F' : 'C'; }

// Fill the temperature placeholders of a translated string: each named token
// holds a Celsius number to convert, and every `{u}` becomes the unit letter.
// Every string that goes through here is a hardware reading, so it follows the
// hardware unit.
// The alternative was a .replace() chain at each call site, which is how the
// hardware headers and the Guardian/briefing toasts ended up printing a hard
// "°C" to someone who had picked °F — the preference is labelled "Temperature
// unit", not "Weather temperature unit", so it has to reach all of them.
// Every token is replaced globally: an anomaly line names two temperatures.
function fillTemps(text, values) {
  let out = String(text == null ? '' : text);
  for (const token of Object.keys(values || {})) {
    out = out.split('{' + token + '}').join(String(toDisplayHwTemp(values[token])));
  }
  return out.split('{u}').join(hwTempUnitSuffix());
}
