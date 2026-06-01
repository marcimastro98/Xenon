'use strict';

function applyUI(isMuted) {
  muted = isMuted;
  const state = isMuted ? 'muted' : 'active';
  micBtn.className = `mic-btn ${state}`;
  ring.className = `ring ${state}`;
  ring2.className = `ring2 ${state}`;
  glow.className = `glow ${state}`;
  label.className = `status-label ${state}`;
  label.textContent = isMuted ? t('mic_muted') : t('mic_active');
  svgOn.style.display = isMuted ? 'none' : '';
  svgOff.style.display = isMuted ? '' : 'none';
}

async function handleTap(e) {
  e.preventDefault();
  if (busy) return;
  busy = true;
  playClick(!muted);
  applyUI(!muted);
  try {
    const res = await fetch(SERVER + '/toggle', { method: 'POST' });
    const data = await res.json();
    applyUI(data.muted);
    setOnline();
  } catch {
    applyUI(!muted);
    setOffline();
  }
  busy = false;
}

async function pollStatus() {
  try {
    const res = await fetch(SERVER + '/status');
    const data = await res.json();
    applyUI(data.muted);
    setOnline();
  } catch { setOffline(); }
}

// Mic mixer shares buildAppMixerRow + the delegated handlers wired in volume.js
// (wireAppMixer covers both the speaker-apps and mic-apps containers).
function renderMicApps(apps) {
  const host = document.getElementById('mic-apps');
  if (!host) return;
  wireAppMixer();
  if (appMixBusy() && host.querySelector('.app-mix-slider')) return;
  if (!apps.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.innerHTML = apps.map(buildAppMixerRow).join('');
  host.hidden = false;
}
