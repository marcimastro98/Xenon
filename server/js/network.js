'use strict';

function setSystemTab(name, options = {}) {
  // System & Network are merged into one "Sistema" view; map any legacy 'net'.
  if (name === 'net') name = 'main';
  if (!['main', 'volume', 'mic'].includes(name)) return;
  currentSysTab = name;
  document.querySelectorAll('.sys-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.systab === name);
  });
  const main = document.getElementById('sys-grid-main');
  const net  = document.getElementById('sys-grid-net');
  const audio = document.getElementById('sys-grid-audio');
  const micPane = document.getElementById('sys-grid-mic');
  const netLabel = document.getElementById('sys-net-label');
  const cap  = document.getElementById('gpu-caption');
  if (main) main.hidden = (name !== 'main');
  if (net)  net.hidden  = (name !== 'main');
  if (netLabel) netLabel.hidden = (name !== 'main');
  // The "Optimize performance" button is contextual to the Sistema view.
  const optBtn = document.getElementById('sys-optimize-btn');
  if (optBtn) optBtn.hidden = (name !== 'main');
  if (audio) audio.hidden = (name !== 'volume');
  if (micPane) micPane.hidden = (name !== 'mic');
  if (cap)  cap.style.display = (name === 'main') ? '' : 'none';

  // The network stats are shown inside the Sistema view, so poll while it's active.
  if (name === 'main') {
    fetchNetwork();
    if (!netInterval) netInterval = setInterval(fetchNetwork, 3000);
  } else if (netInterval) {
    clearInterval(netInterval);
    netInterval = null;
  }

  if (!options.silent && typeof persistDashboardSystemTab === 'function') {
    persistDashboardSystemTab(name);
  }
}

function applyNetworkInto(root, data) {
  const ping = data.ping;
  const lat  = data.latency;
  const fps  = data.fps;

  const pingVal = sf(root, 'net-ping-value');
  const pingFill = sf(root, 'net-ping-fill');
  if (pingVal) pingVal.textContent = (ping == null ? '--' : ping);
  if (pingFill) setFill(pingFill, ping == null ? 0 : 100 - (ping / 2));

  const fpsVal = sf(root, 'net-fps-value');
  const fpsFill = sf(root, 'net-fps-fill');
  if (fpsVal) fpsVal.textContent = (fps == null ? '--' : Math.round(fps));
  if (fpsFill) setFill(fpsFill, fps == null ? 0 : fps / 2.4);
  // Hide the "N/D" badge + the "requires PresentMon" hint once a real FPS reading
  // is available; show them again when no game/FPS source is detected.
  const fpsTag = sf(root, 'net-fps-tag');
  if (fpsTag) fpsTag.hidden = fps != null;
  const fpsBox = fpsVal ? fpsVal.closest('[data-system-card="fps"]') : null;
  const fpsSub = fpsBox ? fpsBox.querySelector('.stat-sub') : null;
  if (fpsSub) fpsSub.hidden = fps != null;

  const latVal = sf(root, 'net-latency-value');
  const latFill = sf(root, 'net-latency-fill');
  if (latVal) latVal.textContent = (lat == null ? '--' : lat);
  if (latFill) setFill(latFill, lat == null ? 0 : 100 - (lat * 5));

  const dn = formatBandwidth(data.downloadBps);
  const up = formatBandwidth(data.uploadBps);
  const dnVal = sf(root, 'net-down-value');
  const dnUnit = sf(root, 'net-down-unit');
  const upVal = sf(root, 'net-up-value');
  const upUnit = sf(root, 'net-up-unit');
  if (dnVal)  dnVal.textContent  = dn.value;
  if (dnUnit) dnUnit.textContent = dn.unit;
  if (upVal)  upVal.textContent  = up.value;
  if (upUnit) upUnit.textContent = up.unit;
}

function applyNetwork(data) {
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => applyNetworkInto(root, data));
  }
}

async function fetchNetwork() {
  if (fetchingNetwork) return;
  fetchingNetwork = true;
  try {
    const res = await fetch(SERVER + '/network');
    if (!res.ok) throw new Error('Network unavailable');
    const data = await res.json();
    applyNetwork(data);
  } catch { }
  fetchingNetwork = false;
}
