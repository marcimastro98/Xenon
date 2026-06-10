'use strict';

// ── Presenza ambientale (opt-in, Settings → Funzioni AI) ────────────────────
// Small proactive moments from Xenon: a fullscreen greeting splash (with
// spoken TTS) when the user first sees the dashboard in a new part of the
// day, a heads-up shortly before
// calendar events that have no explicit reminder, and a voice readout of
// Guardian alerts. Everything is deterministic and local — zero API cost; the
// only cloud call is the optional TTS, which honours the existing aiTtsEnabled
// setting. While the feature is OFF the minute tick is a single boolean check.
(function () {
  const STORE_KEY = 'xenonedge.ambient.v1';
  const HEADSUP_MIN = 10;            // minutes before an event
  const notifiedEventIds = new Set(); // session-scoped heads-up dedupe

  function enabled() {
    return typeof aiFeatureEnabled === 'function' && aiFeatureEnabled('ambient');
  }

  function speak(text) {
    if (!text) return;
    // Stay silent during an active voice session — never talk over the user.
    if (typeof _aiVoiceSessionActive !== 'undefined' && _aiVoiceSessionActive) return;
    const tts = (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings.aiTtsEnabled !== false : false;
    if (tts && typeof _aiSpeak === 'function') {
      try { _aiSpeak(text); } catch { /* toast already shown */ }
    }
  }

  function dayPart(d) {
    const h = d.getHours();
    if (h >= 5 && h < 12) return 'morning';
    if (h >= 12 && h < 18) return 'afternoon';
    if (h >= 18 && h < 23) return 'evening';
    return 'night';
  }

  function readStore() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY));
      return v && typeof v === 'object' ? v : {};
    } catch { return {}; }
  }

  function writeStore(v) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* storage full */ }
  }

  // One greeting per day-part per day (persisted, so reloads don't repeat it).
  function maybeGreet() {
    const now = new Date();
    const part = dayPart(now);
    const dateKey = now.toISOString().slice(0, 10);
    const store = readStore();
    if (store.greetDate === dateKey && store.greetPart === part) return;
    writeStore({ ...store, greetDate: dateKey, greetPart: part });
    const text = t(`greet_${part}`);
    if (window.GreetingSplash) {
      try { GreetingSplash.show(part); } catch { if (typeof showHubToast === 'function') showHubToast('Xenon', text, ''); }
    } else if (typeof showHubToast === 'function') {
      showHubToast('Xenon', text, '');
    }
    speak(text);
  }

  // Heads-up ~10 minutes before events that have NO explicit reminder set
  // (events with reminderAt already get the calendar toast — don't double up).
  function maybeEventHeadsUp() {
    if (typeof calendarEvents === 'undefined' || !Array.isArray(calendarEvents)) return;
    const now = Date.now();
    for (const ev of calendarEvents) {
      if (!ev || !ev.id || !ev.startsAt || ev.reminderAt) continue;
      if (notifiedEventIds.has(ev.id)) continue;
      const starts = Date.parse(ev.startsAt);
      if (!Number.isFinite(starts)) continue;
      const mins = (starts - now) / 60000;
      if (mins <= 0 || mins > HEADSUP_MIN) continue;
      notifiedEventIds.add(ev.id);
      const time = new Intl.DateTimeFormat(t('locale'), { hour: '2-digit', minute: '2-digit' }).format(new Date(starts));
      const text = t('ambient_event_soon').replace('{title}', ev.title || t('ph_title')).replace('{time}', time);
      if (typeof showHubToast === 'function') showHubToast('Xenon', text, '');
      speak(text);
    }
  }

  // Guardian alert already produced a toast in main.js — add the voice moment.
  function onGuardianAlert(text) {
    if (!enabled()) return;
    speak(text);
  }

  function tick() {
    if (!enabled()) return; // disabled → zero work
    // A hidden/background tab must stay silent — with two dashboards open
    // (e.g. the Xeneon Edge plus a desktop browser) both would otherwise
    // greet, each in its own language. The visible one greets on its own
    // tick, or via visibilitychange as soon as it comes back into view.
    if (document.hidden) return;
    maybeGreet();
    maybeEventHeadsUp();
  }

  document.addEventListener('ai-features-changed', () => { if (enabled()) tick(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('load', () => {
    setTimeout(tick, 4000); // let settings + calendar load first
    setInterval(tick, 60000);
  });

  window.Ambient = { onGuardianAlert };
})();
