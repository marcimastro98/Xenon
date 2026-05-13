'use strict';

function setSystemTab(name, options = {}) {
  if (name !== 'main' && name !== 'net') return;
  currentSysTab = name;
  document.querySelectorAll('.sys-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.systab === name);
  });
  const main = document.getElementById('sys-grid-main');
  const net  = document.getElementById('sys-grid-net');
  const cap  = document.getElementById('gpu-caption');
  if (main) main.hidden = (name !== 'main');
  if (net)  net.hidden  = (name !== 'net');
  if (cap)  cap.style.display = (name === 'main') ? '' : 'none';

  if (name === 'net') {
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

function applyNetwork(data) {
  const ping = data.ping;
  const lat  = data.latency;
  const fps  = data.fps;

  const pingVal = document.getElementById('net-ping-value');
  const pingFill = document.getElementById('net-ping-fill');
  if (pingVal) pingVal.textContent = (ping == null ? '--' : ping);
  if (pingFill) {
    const pct = ping == null ? 0 : Math.max(0, Math.min(100, 100 - (ping / 2)));
    pingFill.style.width = pct + '%';
  }

  const fpsVal = document.getElementById('net-fps-value');
  const fpsFill = document.getElementById('net-fps-fill');
  if (fpsVal) fpsVal.textContent = (fps == null ? '--' : Math.round(fps));
  if (fpsFill) fpsFill.style.width = (fps == null ? 0 : Math.max(0, Math.min(100, fps / 2.4))) + '%';

  const latVal = document.getElementById('net-latency-value');
  const latFill = document.getElementById('net-latency-fill');
  if (latVal) latVal.textContent = (lat == null ? '--' : lat);
  if (latFill) {
    const pct = lat == null ? 0 : Math.max(0, Math.min(100, 100 - (lat * 5)));
    latFill.style.width = pct + '%';
  }

  const dn = formatBandwidth(data.downloadBps);
  const up = formatBandwidth(data.uploadBps);
  const dnVal = document.getElementById('net-down-value');
  const dnUnit = document.getElementById('net-down-unit');
  const upVal = document.getElementById('net-up-value');
  const upUnit = document.getElementById('net-up-unit');
  if (dnVal)  dnVal.textContent  = dn.value;
  if (dnUnit) dnUnit.textContent = dn.unit;
  if (upVal)  upVal.textContent  = up.value;
  if (upUnit) upUnit.textContent = up.unit;
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
