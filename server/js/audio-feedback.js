'use strict';

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function unlockAudio() {
  if (!audioCtx || audioCtx.state === 'running') return;
  try { audioCtx.resume().catch(() => {}); } catch { }
}

['pointerdown', 'keydown', 'touchstart'].forEach(type => {
  window.addEventListener(type, unlockAudio, { once: true, passive: true });
});

// Notification sounds honour the master Notifiche switch plus a dedicated
// `sounds` sub-toggle (Settings → Notifiche). Read live from hubSettings so a
// change takes effect without reload; TDZ/undefined-safe because settings.js
// loads after this module (the reference only resolves at play time, by which
// point hubSettings is initialised). Default ON until settings are available.
function notifSoundsOn() {
  try {
    const n = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.notifications : null;
    if (!n) return true;
    return n.enabled !== false && n.sounds !== false;
  } catch { return true; }
}

function playClick(toMuted) {
  unlockAudio();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  const now = audioCtx.currentTime;
  osc.type = 'sine';
  osc.frequency.setValueAtTime(toMuted ? 480 : 620, now);
  osc.frequency.exponentialRampToValueAtTime(toMuted ? 220 : 380, now + 0.08);
  gain.gain.setValueAtTime(0.16, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  osc.start(now);
  osc.stop(now + 0.13);
}

function playReminderBurst() {
  unlockAudio();
  if (!audioCtx) return;
  const start = audioCtx.currentTime + 0.02;
  const notes = [880, 660, 990, 740];
  notes.forEach((freq, index) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();
    const at = start + index * 0.16;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, at);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.78, at + 0.13);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.30, at + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.145);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + 0.17);
  });
}

function stopReminderSound() {
  reminderSoundTimers.forEach(timer => clearTimeout(timer));
  reminderSoundTimers = [];
}

function playReminderSound() {
  stopReminderSound();
  // The calendar reminder keeps its own stronger, repeating alarm; the master
  // Notifiche → sounds toggle silences the audible part but the haptic buzz
  // stays (a separate channel that still signals an important reminder).
  if (notifSoundsOn()) {
    playReminderBurst();
    reminderSoundTimers = [
      setTimeout(playReminderBurst, 900),
      setTimeout(playReminderBurst, 1800),
      setTimeout(playReminderBurst, 2700),
    ];
  }
  if (navigator.vibrate) {
    try { navigator.vibrate([180, 80, 180, 80, 260]); } catch { }
  }
}

function dismissReminderToast() {
  if (window.XenonToast) window.XenonToast.dismissAll();
  stopReminderSound();
}

// ── Notification cues (synthesized, asset-free) ──────────────────────────────
// One soft motif per toast type, in the same WebAudio style as the reminder
// burst (triangle + lowpass, gentle exponential envelope). Routine info/success
// toasts are intentionally silent so everyday confirmations ("settings saved",
// "memory cleared") don't chirp. 'reminder' is silent here too — the calendar's
// stronger repeating alarm (playReminderSound) covers it, so it isn't doubled.
// Each entry is a list of [timeOffsetSec, frequencyHz] steps.
const NOTIFY_CUES = {
  notification: [[0, 660], [0.10, 880]],
  timer:        [[0, 784], [0.11, 1047], [0.22, 1319]],
  update:       [[0, 523], [0.10, 784]],
  warning:      [[0, 740], [0.11, 555]],
  error:        [[0, 300], [0.12, 200]],
};

function playNotifyCue(type) {
  if (!audioCtx || !notifSoundsOn()) return;
  const seq = NOTIFY_CUES[type];
  if (!seq) return;   // info / success / reminder → silent
  unlockAudio();
  const start = audioCtx.currentTime + 0.02;
  seq.forEach(([offset, freq]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();
    const at = start + offset;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, at);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(3200, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.16, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + 0.19);
  });
}

window.XenonSound = { play: playNotifyCue };
