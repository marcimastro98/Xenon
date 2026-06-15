'use strict';

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function unlockAudio() {
  if (!audioCtx || audioCtx.state === 'running') return;
  try { audioCtx.resume().catch(() => {}); } catch { }
}

['pointerdown', 'keydown', 'touchstart'].forEach(type => {
  window.addEventListener(type, unlockAudio, { once: true, passive: true });
});

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
  playReminderBurst();
  reminderSoundTimers = [
    setTimeout(playReminderBurst, 900),
    setTimeout(playReminderBurst, 1800),
    setTimeout(playReminderBurst, 2700),
  ];
  if (navigator.vibrate) {
    try { navigator.vibrate([180, 80, 180, 80, 260]); } catch { }
  }
}

function dismissReminderToast() {
  if (window.XenonToast) window.XenonToast.dismissAll();
  stopReminderSound();
}
