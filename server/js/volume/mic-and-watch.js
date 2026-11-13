// The microphone's volume, reading the audio state from the engine, and when to keep watching it.
'use strict';

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
    const res = await fetchWithDeadline(SERVER + '/audio', POLL_FETCH_TIMEOUT_MS);
    const data = await res.json();
    applyAudio(data);
    setOnline();
  } catch { setOffline(); } finally {
    // Deadline + `finally`: without both, one hung request retires this poller
    // for the whole page (see fetchWithDeadline in utils.js).
    fetchingAudio = false;
  }
}

// ── A mixer that is looked at stays live ────────────────────────────────────
// The server reads the volume of every app (a SoundVolumeView process each time)
// only while somebody is using the Volume panel: any audio request keeps that
// going for two minutes, then it stops (audioPollWanted in server.js). Opening the
// panel fetches once, so the mixer showed whatever was playing at that moment and
// then nothing arrived: a game or a call that started later never appeared, and the
// list sat empty ("it used to show every app, now it shows nothing"). So while a
// Volume or Microphone surface is really on screen this says so every 30 seconds,
// and it fetches the moment one comes into view (the tab was opened, the page was
// swiped to). Nothing is asked while none is on screen, which is what the
// two-minute rule was for.
const AUDIO_WATCH_TICK_MS = 4000;
const AUDIO_WATCH_PING_MS = 30000;
let audioWatching = false;
let audioWatchPingAt = 0;

// On screen means laid out (not display:none on it or on anything above it: a
// closed tab, an unextracted card) and inside the viewport (a page that is not the
// current one sits off to the side).
function audioSurfaceOnScreen() {
  if (document.hidden) return false;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // The "audio unavailable" notice counts too: it is what the panel shows while the
  // read is failing, and only a read that keeps being tried can take it away again.
  // The Microphone tab of the System tile holds the mic's content in its own pane.
  const surfaces = document.querySelectorAll('.volume-wrap, .mic-panel, .system-mic-pane, [data-volf="vol-error"]');
  for (const el of surfaces) {
    if (!el.getClientRects().length) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh) return true;
  }
  return false;
}

function audioWatchTick() {
  const on = audioSurfaceOnScreen();
  const now = Date.now();
  if (on && !audioWatching) {
    audioWatchPingAt = now;
    fetchAudio();
  } else if (on && now - audioWatchPingAt >= AUDIO_WATCH_PING_MS) {
    audioWatchPingAt = now;
    fetch(SERVER + '/audio/watch').catch(() => {});
  }
  audioWatching = on;
}
