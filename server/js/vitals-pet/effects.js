// What the pet remembers while the page runs, and what it does besides talking: its mood on every
// Bit it shows, its 8-bit sounds, the fading and the glitch of the dashboard, and what it asks the
// server to do to the PC.
'use strict';

(() => {
  const { petCfg, lang, vitalName, memState } = window.VitalsPetSaved;

  const PRESENT_IDLE_S = 180;      // system input within 3 min = user is at the PC

  const GLITCH_EVERY_MS = 45000;   // glitch pulse cadence while decay is active

  // The pet's moods are the engine's mood clips, so this Bit is the same one
  // the chat, the Maker and the game companion show. The engine animates and
  // holds itself (game mode, low power, idle, frosted overlay, reduced motion).
  const CLIP = { happy: 'happy', neutral: 'idle', worried: 'worry', angry: 'angry', sleep: 'sleep', ghost: 'drowsy' };
  const MOOD_RGB = { happy: '110,231,135', neutral: '255,215,94', worried: '255,166,87', angry: '255,90,95', sleep: '138,180,248', ghost: '232,244,255' };

  const state = {
    host: null,            // floating pet root element
    chip: null,            // topbar mini-Bit button (#clock-bit)
    tickTimer: null,
    bubbleTimer: null,
    typeTimer: null,
    chipBubbleEl: null,
    chipBubbleTimer: null,
    glitchAt: 0,
    lockCountTimer: null,
    lastNagAt: 0,
    lastAiAt: 0,           // AI-roast cooldown (own budget, apart from state.lastNagAt)
    roastGen: 0,           // bumped on refill/truce/teardown — stale async roasts are dropped
    nightGreeted: false,   // "why are you awake" fired once per night session
    status: { gaming: false, idleSec: null },
    prevGaming: false,
    diedDuringGame: '',    // vital that hit zero while quiet-in-game held fire
    mood: '',
    audioCtx: null,
    gameOverEl: null,
    // What this PC can do (server/vitals-nag.js): read once per page. Until it
    // answers, every rung stays as the user set it; the server still says no
    // to what cannot work, but a warning that promises it is never shown.
    pcCaps: null,
  };

  function present() { return typeof state.status.idleSec === 'number' && state.status.idleSec >= 0 && state.status.idleSec < PRESENT_IDLE_S; }

  // Ask the configured Xenon AI provider for ONE in-character line built from
  // real context. Best-effort with a hard timeout: any failure, empty reply or
  // missing provider falls back to the offline bank — the caller awaits only
  // the TEXT, never the escalation itself. _aiProviderCfg/_aiProviderReady are
  // ai.js top-level globals (ai.js loads before this script); typeof-guarded
  // for surfaces that don't load ai.js.
  function roastCtx(kind, vital, deadMs) {
    const mem = memState();
    const h = new Date().getHours();
    const timeOfDay = h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 23 ? 'evening' : 'night';
    const md = (typeof mediaData !== 'undefined' && mediaData && mediaData.active) ? mediaData : null;
    const wd = (typeof weatherData !== 'undefined' && weatherData && weatherData.ok) ? weatherData : null;
    return {
      kind,
      vital: vital ? vitalName(vital) : '',
      min: Math.max(0, Math.round((deadMs || 0) / 60000)),
      streak: Number(mem.streak) || 0,
      gaming: state.status.gaming === true,
      timeOfDay,
      media: md ? [md.title, md.artist].filter(Boolean).join(' — ').slice(0, 80) : '',
      weather: wd ? [wd.condition, wd.tempC != null ? Math.round(wd.tempC) + '°C' : ''].filter(Boolean).join(', ').slice(0, 60) : '',
    };
  }

  function sound(name) {
    if (petCfg().sounds === false) return;
    try {
      if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (state.audioCtx.state === 'suspended') { state.audioCtx.resume().catch(() => {}); if (state.audioCtx.state === 'suspended') return; }
      const SEQ = {
        talk:     [[523, 60], [659, 70]],
        angry:    [[220, 90], [174, 90], [147, 130]],
        gameover: [[392, 130], [330, 130], [262, 130], [196, 240]],
        praise:   [[523, 70], [659, 70], [784, 70], [1047, 150]],
        warn:     [[880, 110], [587, 110], [880, 110], [587, 110]],
      }[name];
      if (!SEQ) return;
      let at = state.audioCtx.currentTime + 0.02;
      SEQ.forEach(([f, d]) => {
        const osc = state.audioCtx.createOscillator();
        const gain = state.audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.035, at);
        gain.gain.exponentialRampToValueAtTime(0.001, at + d / 1000);
        osc.connect(gain).connect(state.audioCtx.destination);
        osc.start(at);
        osc.stop(at + d / 1000 + 0.02);
        at += d / 1000;
      });
    } catch { /* audio blocked or unavailable — silence is acceptable */ }
  }

  // One state machine, two mounts: the floating pet and the topbar chip each
  // carry a live Bit, and setMood()/react() fan out to both, so there is never
  // a second mood ladder.
  function bits() {
    const app = window.BitApp;
    if (!app) return [];
    return [state.host && state.host.querySelector('.vpet-sprite'), state.chip && state.chip.querySelector('.cb-sprite')]
      .map((el) => el && app.playerFor(el)).filter(Boolean);
  }

  function mountBit(el, fidgets) {
    if (window.BitApp) window.BitApp.mount(el, { mood: CLIP[state.mood] || 'idle', fidgets });
  }

  // A one-off move (a refill, a welcome back); the mood comes back after it.
  function react(clipId) {
    bits().forEach((p) => p.play(clipId));
  }

  // Let go of the players whose host just left the page.
  function releaseBits() {
    if (window.BitApp) window.BitApp.sweep();
  }

  function setMood(next, force) {
    if (next === state.mood && !force) return;
    state.mood = next;
    [state.host, state.chip].forEach((el) => {
      if (!el) return;
      el.dataset.mood = next;
      el.style.setProperty('--vpet-rgb', MOOD_RGB[next] || MOOD_RGB.neutral);
    });
    bits().forEach((p) => p.setMood(CLIP[next] || 'idle'));
  }

  function pager() { return document.getElementById('dashboard-pager'); }

  // Progressive decay: `depth` 0..1 drives how far the dashboard has drained of
  // colour (0 = untouched, 1 = full black & white). The engine ramps it up the
  // longer a vital rots at zero; a refill drops it straight back to 0. The class
  // toggle (not just the var) is what lets a refill fully clear the effect.
  function setDecay(depth) {
    const p = pager();
    const d = Math.max(0, Math.min(1, Number(depth) || 0));
    if (p) {
      p.classList.toggle('vpet-decay', d > 0);
      if (d > 0) p.style.setProperty('--vpet-decay', d.toFixed(3));
      else p.style.removeProperty('--vpet-decay');
    }
    if (d <= 0) state.glitchAt = 0;
  }

  function glitchPulse(now) {
    if (document.hidden || (!state.host && !state.chip)) return;
    if (now - state.glitchAt < GLITCH_EVERY_MS) return;
    state.glitchAt = now;
    const g = document.createElement('div');
    g.className = 'vpet-glitch';
    document.body.appendChild(g);
    setTimeout(() => g.remove(), 900);
  }

  function closeGameOver() { if (state.gameOverEl) { state.gameOverEl.remove(); state.gameOverEl = null; } }

  async function readPcCaps() {
    try {
      const res = await fetch('/api/vitals/caps', { cache: 'no-store' });
      const body = res.ok ? await res.json() : null;
      if (body && body.ok) state.pcCaps = body;
    } catch { /* offline: the server refuses what it cannot do */ }
  }

  const pcCan = (step) => {
    if (!state.pcCaps) return true;
    if (step === 'monitors') return !!state.pcCaps.popup;
    if (step === 'minimize') return !!(state.pcCaps.minimize && state.pcCaps.minimize.ok);
    return true;
  };

  function serverNag(action, extra) {
    try {
      fetch('/api/vitals/nag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send the UI language so the PC-side popup can pick a font that can
        // actually render the script (Consolas has no CJK glyphs → tofu boxes).
        body: JSON.stringify(Object.assign({ action, lang: lang() }, extra || {})),
      }).catch(() => {});
    } catch { /* offline — the dashboard-side nagging carries on */ }
  }

  // Bit's rage → a dedicated red LED burst (the 'vitals' event flash). Opt-in via
  // Settings → Bit ("Fai lampeggiare i LED quando si arrabbia"); a no-op if the
  // user has no lighting configured (the server just ignores the event).
  function ledFlash() {
    try {
      fetch('/api/lighting/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'vitals' }),
      }).catch(() => {});
    } catch { /* lighting optional */ }
  }

  window.VitalsPetEffects = {
    CLIP, MOOD_RGB, state, present, roastCtx, sound, mountBit, react, releaseBits, setMood, setDecay,
    glitchPulse, closeGameOver, readPcCaps, pcCan, serverNag, ledFlash,
  };
})();
