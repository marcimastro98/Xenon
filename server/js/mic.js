'use strict';

function applyUI(isMuted) {
  muted = isMuted;
  const state = isMuted ? 'muted' : 'active';
  document.querySelectorAll('[data-micf="mic-btn"]').forEach(el => { el.className = `mic-btn ${state}`; });
  document.querySelectorAll('[data-micf="ring"]').forEach(el => { el.className = `ring ${state}`; });
  document.querySelectorAll('[data-micf="ring2"]').forEach(el => { el.className = `ring2 ${state}`; });
  document.querySelectorAll('[data-micf="glow"]').forEach(el => { el.className = `glow ${state}`; });
  document.querySelectorAll('[data-micf="status-label"]').forEach(el => { el.className = `status-label ${state}`; el.textContent = isMuted ? t('mic_muted') : t('mic_active'); });
  document.querySelectorAll('[data-micf="svg-on"]').forEach(el => { el.style.display = isMuted ? 'none' : ''; });
  document.querySelectorAll('[data-micf="svg-off"]').forEach(el => { el.style.display = isMuted ? '' : 'none'; });
  if (window.Deck && typeof window.Deck.refreshStates === 'function') window.Deck.refreshStates({ micMuted: !!isMuted });
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
    if (typeof applyGameMode === 'function') applyGameMode(!!data.gaming);
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
