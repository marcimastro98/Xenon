// Builds the short sounds of timers, reminders and notifications from a list of notes.

const { pcmToWav } = require('../wav/pcm-to-wav.js');

// Notes as [Hz, start s, decay?]. wake/close are the timer chimes; the others are
// the toast cues of js/audio-feedback.js NOTIFY_CUES, one cycle of its
// RING_PATTERN and the calendar alarm of playReminderSound, played here for the
// on-screen alerts window, which never gets the click a page needs before it may
// play audio.
const REMINDER_BURST = [880, 660, 990, 740];
const REMINDER_NOTES = [0, 0.9, 1.8, 2.7].flatMap(at => REMINDER_BURST.map((hz, i) => [hz, Math.round((at + i * 0.16) * 100) / 100, 20]));
const CHIME_NOTES = Object.freeze({
  wake: [[784, 0], [1046, 0.13]],
  close: [[660, 0], [440, 0.13]],
  notification: [[660, 0], [880, 0.10]],
  update: [[523, 0], [784, 0.10]],
  warning: [[740, 0], [555, 0.11]],
  error: [[300, 0], [200, 0.12]],
  ring: [[660, 0], [880, 0.18]],
  reminder: REMINDER_NOTES,
});
const chimeKind = (kind) => (Object.hasOwn(CHIME_NOTES, kind) ? kind : 'wake');

function _buildChimeWav(kind) {
  const rate = 24000;
  const notes = CHIME_NOTES[chimeKind(kind)];
  const dur = Math.max(0.6, Math.max(...notes.map(n => n[1])) + 0.3);
  const total = Math.floor(rate * dur);
  const buf = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const t = i / rate;
    let s = 0;
    for (const [freq, start, decay = 4] of notes) {
      if (t >= start) {
        const lt = t - start;
        const env = Math.exp(-lt * decay) * (1 - Math.exp(-lt * 80));
        s += Math.sin(2 * Math.PI * freq * lt) * env;
      }
    }
    s = Math.max(-1, Math.min(1, s * 0.08));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return pcmToWav(buf, rate, 1, 16);
}

// Every surface that sees a timer end asks for the chime (the dashboard, the
// on-screen alerts window, a second dashboard): requests for the same sound
// this close together are one event, so it plays once.
const CHIME_COALESCE_MS = 1500;

module.exports = {
  REMINDER_BURST, REMINDER_NOTES, CHIME_NOTES, chimeKind, _buildChimeWav, CHIME_COALESCE_MS,
};
