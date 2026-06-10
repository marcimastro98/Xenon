'use strict';

function refreshSlider(v) {
  const safe = Math.max(0, Math.min(100, Number(v) || 0));
  const bg = `linear-gradient(to right, var(--slider-fill) 0%, var(--slider-fill) ${safe}%, var(--slider-track) ${safe}%, var(--slider-track) 100%)`;
  document.querySelectorAll('[data-volf="vol-slider"]').forEach(el => { el.style.background = bg; });
}

function refreshMicSlider(v) {
  const safe = Math.max(0, Math.min(100, Number(v) || 0));
  document.querySelectorAll('[data-micf="mic-vol-slider"]').forEach(el => {
    const isMuted = el.classList.contains('muted');
    const track = el.closest('.mic-vol-track');
    if (track) {
      track.style.setProperty('--mic-level', safe + '%');
      track.classList.toggle('muted', isMuted);
    }
    el.style.background = 'transparent';
  });
}

function onSliderInput(v) {
  const level = parseInt(v, 10);
  document.querySelectorAll('[data-volf="vol-val"]').forEach(el => { el.textContent = level + '%'; });
  refreshSlider(level);
  clearTimeout(volDebounce);
  volDebounce = setTimeout(() => sendVolume(level), 120);
}

async function sendVolume(level) {
  try {
    const res = await fetch(SERVER + '/volume/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    if (!res.ok) throw new Error('Volume failed');
    setOnline();
  } catch { setOffline(); }
}

async function toggleSpeakerMute() {
  const previous = speakerMuted;
  applySpeakerMute(!speakerMuted);
  try {
    const res = await fetch(SERVER + '/speaker/mute', { method: 'POST' });
    if (!res.ok) throw new Error('Speaker mute failed');
    setOnline();
    setTimeout(fetchAudio, 350);
  } catch {
    applySpeakerMute(previous);
    setOffline();
  }
}

function applySpeakerMute(m) {
  speakerMuted = m;
  document.querySelectorAll('[data-volf="vol-mute-btn"]').forEach(el => { el.classList.toggle('speaker-muted', m); });
  document.querySelectorAll('[data-volf="vol-slider"]').forEach(el => { el.classList.toggle('speaker-muted', m); });
  document.querySelectorAll('[data-volf="spk-icon-on"]').forEach(el => { el.style.display = m ? 'none' : ''; });
  document.querySelectorAll('[data-volf="spk-icon-off"]').forEach(el => { el.style.display = m ? '' : 'none'; });
  if (window.Deck && typeof window.Deck.refreshStates === 'function') window.Deck.refreshStates({ speakerMuted: !!m });
}

function applyAudio(data) {
  audioData = data;
  if (data.speaker) {
    const speaker = data.speaker.name || data.speaker.label;
    document.querySelectorAll('[data-volf="spk-name"]').forEach(el => { el.textContent = speaker; });
    const vol = data.speaker.volume;
    document.querySelectorAll('[data-volf="vol-slider"]').forEach(el => { el.value = vol; });
    document.querySelectorAll('[data-volf="vol-val"]').forEach(el => { el.textContent = vol + '%'; });
    refreshSlider(vol);
    applySpeakerMute(data.speaker.muted);
  }
  if (data.mic) {
    const mic = data.mic.name || data.mic.label;
    document.querySelectorAll('[data-volf="mic-name"]').forEach(el => { el.textContent = mic; });
    if (micContext) micContext.textContent = mic;
    const mv = Number(data.mic.volume);
    if (Number.isFinite(mv)) {
      document.querySelectorAll('[data-micf="mic-vol-slider"]').forEach(el => {
        if (document.activeElement !== el) {
          el.value = mv;
        }
      });
      document.querySelectorAll('[data-micf="mic-vol-val"]').forEach(el => { el.textContent = mv + '%'; });
    }
    document.querySelectorAll('[data-micf="mic-vol-slider"]').forEach(el => {
      el.classList.toggle('muted', !!data.mic.muted);
    });
    refreshMicSlider(
      (() => {
        const first = document.querySelector('[data-micf="mic-vol-slider"]');
        return first ? first.value : 0;
      })()
    );
  }
  if (Array.isArray(data.speakerApps)) renderSpeakerApps(data.speakerApps);
  if (Array.isArray(data.micApps)) renderMicApps(data.micApps);
  // Keep the media tile's per-source volume in sync with live audio updates.
  if (typeof updateMediaSource === 'function') updateMediaSource();
  // Refresh any Deck's Standby screen so its device name + volume meter stay live.
  if (window.Deck && typeof window.Deck.updateMedia === 'function') window.Deck.updateMedia();
}

function appMixSliderBg(vol) {
  const v = Math.max(0, Math.min(100, Number(vol) || 0));
  return `linear-gradient(to right,var(--slider-fill) 0%,var(--slider-fill) ${v}%,var(--slider-track) ${v}%,var(--slider-track) 100%)`;
}

// Speaker / muted glyphs for the per-app mute button.
const APP_MIX_SVG_ON = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02ZM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77 0-4.28-2.99-7.86-7-8.77Z"/></svg>';
const APP_MIX_SVG_MUTED = '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63Zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z"/></svg>';

function appMixDisplayName(app) {
  const base = app.proc || app.name || 'App';
  return typeof prettyAppName === 'function' ? prettyAppName(base) : base;
}

// The session id (SoundVolumeView CLI id) can contain backslashes and other
// characters that break inline event handlers, so it lives only in
// data-app-id and is read back through event delegation (see wireAppMixer).
function buildAppMixerRow(app) {
  const display = appMixDisplayName(app);
  const safeName = escHtml(display);
  const initial = (display[0] || 'A').toUpperCase();
  const iconHtml = app.icon
    ? `<img class="app-mix-icon" src="${app.icon}" alt="">`
    : `<span class="app-mix-icon app-mix-icon-letter">${escHtml(initial)}</span>`;
  const muteClass = app.muted ? ' app-mix-muted' : '';
  const bg = appMixSliderBg(app.volume);
  return `
    <div class="app-mix-row${muteClass}" data-app-id="${escHtml(app.id)}" data-app-proc="${escHtml(app.proc || '')}">
      ${iconHtml}
      <span class="app-mix-name" title="${safeName}">${safeName}</span>
      <input class="app-mix-slider" type="range" min="0" max="100" value="${app.volume}" style="background:${bg}">
      <span class="app-mix-vol">${app.volume}%</span>
      <button class="app-mix-mute${app.muted ? ' active' : ''}" type="button" title="Mute">
        ${app.muted ? APP_MIX_SVG_MUTED : APP_MIX_SVG_ON}
      </button>
    </div>`;
}

// Both the speaker and mic mixers post to the same per-app endpoints, so a
// single delegated handler per container covers them. Wired once; survives the
// innerHTML re-renders because the listeners sit on the persistent container.
function wireAppMixer() {
  if (wireAppMixer.done) return;
  wireAppMixer.done = true;
  ['speaker-apps', 'mic-apps'].forEach(id => {
    const host = document.getElementById(id);
    if (!host) return;
    host.addEventListener('input', e => {
      const slider = e.target.closest('.app-mix-slider');
      if (slider) handleAppMixInput(slider);
    });
    host.addEventListener('click', e => {
      const btn = e.target.closest('.app-mix-mute');
      if (btn) handleAppMixMute(btn);
    });
  });
}

function handleAppMixInput(slider) {
  const row = slider.closest('.app-mix-row');
  if (!row) return;
  const id = row.dataset.appId;
  // The process name outlives the session CLI id (which rotates when the app
  // restarts), so it rides along as the server's preferred durable target.
  const proc = row.dataset.appProc || '';
  const level = parseInt(slider.value, 10);
  lastAppMixTouch = Date.now();
  const volEl = row.querySelector('.app-mix-vol');
  if (volEl) volEl.textContent = level + '%';
  slider.style.background = appMixSliderBg(level);
  row.classList.remove('app-mix-muted');
  clearTimeout(appVolDebounce[id]);
  appVolDebounce[id] = setTimeout(() => {
    fetch(SERVER + '/audio/app/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, level, proc }),
    }).catch(() => {});
  }, 120);
}

async function handleAppMixMute(btn) {
  const row = btn.closest('.app-mix-row');
  if (!row) return;
  const id = row.dataset.appId;
  const proc = row.dataset.appProc || '';
  lastAppMixTouch = Date.now();
  const nowMuted = !btn.classList.contains('active');
  btn.classList.toggle('active', nowMuted);
  row.classList.toggle('app-mix-muted', nowMuted);
  btn.innerHTML = nowMuted ? APP_MIX_SVG_MUTED : APP_MIX_SVG_ON;
  try {
    await fetch(SERVER + '/audio/app/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, muted: nowMuted, proc }),
    });
  } catch {}
}

// Skip a re-render while the user is actively dragging a slider so the live SSE
// refresh (every few seconds) never fights the gesture.
function appMixBusy() {
  return Date.now() - lastAppMixTouch < 1500;
}

function renderSpeakerApps(apps) {
  const host = document.getElementById('speaker-apps');
  if (!host) return;
  wireAppMixer();
  if (appMixBusy() && host.querySelector('.app-mix-slider')) return;
  if (!apps.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.innerHTML = apps.map(buildAppMixerRow).join('');
  host.hidden = false;
}

function onMicVolumeInput(v) {
  const level = parseInt(v, 10);
  document.querySelectorAll('[data-micf="mic-vol-val"]').forEach(el => { el.textContent = level + '%'; });
  refreshMicSlider(level);
  clearTimeout(micVolDebounce);
  micVolDebounce = setTimeout(() => sendMicVolume(level), 150);
}

async function sendMicVolume(level) {
  try {
    const res = await fetch(SERVER + '/mic/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    if (!res.ok) throw new Error('Mic volume failed');
    setOnline();
  } catch { setOffline(); }
}

async function fetchAudio() {
  if (fetchingAudio) return;
  fetchingAudio = true;
  try {
    const res = await fetch(SERVER + '/audio');
    const data = await res.json();
    applyAudio(data);
    setOnline();
  } catch { setOffline(); }
  fetchingAudio = false;
}
