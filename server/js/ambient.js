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

  // Per-type proactive-moment toggle (Settings → Performance → Momenti
  // proattivi). Default ON. `hubSettings` is the bare shared script-scope let
  // from settings.js — it is NOT window.hubSettings.
  function proactiveOn(type) {
    const p = (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings.proactive : null;
    return !p || p[type] !== false;
  }

  // Today's next events (max 3) for the morning-briefing card in the splash.
  function todayAgenda(now) {
    if (typeof calendarEvents === 'undefined' || !Array.isArray(calendarEvents)) return [];
    const fmt = new Intl.DateTimeFormat(t('locale'), { hour: '2-digit', minute: '2-digit' });
    const out = [];
    for (const ev of calendarEvents) {
      if (!ev || !ev.startsAt || !ev.title) continue;
      const starts = new Date(ev.startsAt);
      if (Number.isNaN(starts.getTime())) continue;
      if (starts.toDateString() !== now.toDateString() || starts <= now) continue;
      out.push({ at: starts.getTime(), time: fmt.format(starts), title: String(ev.title) });
    }
    return out.sort((a, b) => a.at - b.at).slice(0, 3);
  }

  // One greeting per day-part per day (persisted, so reloads don't repeat it).
  function maybeGreet() {
    const now = new Date();
    const part = dayPart(now);
    const dateKey = now.toISOString().slice(0, 10);
    const store = readStore();
    if (store.greetDate === dateKey && store.greetPart === part) return;
    writeStore({ ...store, greetDate: dateKey, greetPart: part });
    // Morning briefing: the greeting also carries (and speaks) today's first
    // events when the proactive "morning" moment is enabled.
    const agenda = (part === 'morning' && proactiveOn('morning')) ? todayAgenda(now) : [];
    let text = t(`greet_${part}`);
    if (agenda.length) {
      const first = agenda[0];
      const spoken = (agenda.length === 1 ? t('ambient_agenda_one') : t('ambient_agenda_many'))
        .replace('{n}', String(agenda.length))
        .replace('{title}', first.title)
        .replace('{time}', first.time);
      text = `${text} ${spoken}`;
    }
    if (window.GreetingSplash) {
      try { GreetingSplash.show(part, agenda); } catch { if (typeof showHubToast === 'function') showHubToast('Xenon', text, ''); }
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

  function fmtMinutes(m) {
    const mins = Math.max(1, Math.round(m || 0));
    const h = Math.floor(mins / 60);
    return h > 0 ? `${h}h ${String(mins % 60).padStart(2, '0')}min` : `${mins} min`;
  }

  // Server-side proactive moment (SSE 'briefing'): game-session recap or a
  // sustained-thermal alert. The server already gates each type on its toggle,
  // so the toast always shows; the voice is added only when the ambient
  // presence is enabled (same discipline as Guardian alerts).
  function onBriefingMoment(d) {
    if (!d || typeof d !== 'object') return;
    let title = 'Xenon';
    let text = '';
    if (d.type === 'recap') {
      const game = String(d.game || '').replace(/\.exe$/i, '');
      const name = game ? game.charAt(0).toUpperCase() + game.slice(1) : t('brief_recap_title');
      const parts = [`${name} — ${fmtMinutes(d.minutes)}`];
      if (typeof d.avgFps === 'number') {
        parts.push(t('brief_recap_fps')
          .replace('{avg}', String(d.avgFps))
          .replace('{max}', String(typeof d.maxFps === 'number' ? d.maxFps : d.avgFps)));
      }
      if (typeof d.gpuTempMax === 'number') parts.push(t('brief_recap_gpu').replace('{v}', String(d.gpuTempMax)));
      else if (typeof d.cpuTempMax === 'number') parts.push(t('brief_recap_cpu').replace('{v}', String(d.cpuTempMax)));
      title = t('brief_recap_title');
      text = parts.join(' · ');
    } else if (d.type === 'thermal') {
      const key = d.metric === 'cpu' ? 'brief_thermal_cpu' : 'brief_thermal_gpu';
      text = t(key).replace('{v}', String(d.value)).replace('{m}', String(d.minutes));
    } else if (d.type === 'anomaly') {
      const key = d.metric === 'cpu' ? 'brief_anomaly_cpu' : 'brief_anomaly_gpu';
      text = t(key).replace('{v}', String(d.value)).replace('{b}', String(d.baseline));
      title = t('brief_anomaly_title');
    }
    if (!text) return;
    if (typeof showHubToast === 'function') showHubToast(title, text, '');
    if (enabled()) speak(text);
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

  window.Ambient = { onGuardianAlert, onBriefingMoment };
})();
