'use strict';

// Shared surface-agnostic constants live in @xenon/core (served at /shared).
// Fall back to inline literals so the dashboard still boots if /shared is briefly
// unavailable — the values must stay identical to packages/core/src/constants.js.
const _xcConst = (typeof window !== 'undefined' && window.Xenon && window.Xenon.constants) || null;

// ── Server ───────────────────────────────────────────────────
const SERVER = (_xcConst && _xcConst.LOOPBACK_ORIGIN) || 'http://127.0.0.1:3030';

// ── Mic state ────────────────────────────────────────────────
let muted = false;
let busy = false;

// ── Debounce timers ──────────────────────────────────────────
let volDebounce = null;
let micVolDebounce = null;
const appVolDebounce = {};   // keyed by app session id (speaker + mic mixers)
let lastAppMixTouch = 0;     // timestamp of last per-app slider/mute interaction

// ── Audio data cache ─────────────────────────────────────────
let audioData = null;
let speakerMuted = false;

// ── Media state ──────────────────────────────────────────────
let mediaData = null;
let weatherData = null;
let fetchingMedia = false;
let fetchingSystem = false;
let fetchingAudio = false;
let fetchingWeather = false;

// ── Calendar state ───────────────────────────────────────────
let calendarEvents = [];
let calendarViewDate = new Date();
let selectedCalendarDate = toDateInputValue(new Date());
let calendarMode = false;
let calendarAutoShown = false;
let calendarLoaded = false;
let modalDateValue = null;

// ── Language ─────────────────────────────────────────────────
const SUPPORTED_LANGS = (_xcConst && _xcConst.SUPPORTED_LANGS) || Object.freeze(['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']);

const normalizeLangCode = (_xcConst && _xcConst.normalizeLangCode) || function (value) {
  const code = String(value || '').toLowerCase().split('-')[0];
  return SUPPORTED_LANGS.includes(code) ? code : '';
};

let lang = normalizeLangCode(localStorage.getItem('uiLang')) || normalizeLangCode(navigator.language) || 'en';

// ── Toast / reminder timers ───────────────────────────────────
let toastTimer = null;
let reminderSoundTimers = [];

// ── System panel state ────────────────────────────────────────
let systemDisks = null;
let diskIndex = 0;

// ── Network panel state ───────────────────────────────────────
let currentSysTab = 'main';
let fetchingNetwork = false;
let netInterval = null;

// ── Notes state ───────────────────────────────────────────────
let notesSaveTimer = null;
let notesStatusTimer = null;
let notesIdleBlurTimer = null;
let notesLoaded = false;
let notesLoadRetryTimer = null;
let notesLoadRetryDelay = 1000;
// Structured multi-note store, mirrored from GET /notes/list. Rendered into every
// notes widget instance (Agenda tab, extracted panel, duplicates) by notes.js.
let notesState = { v: 1, activeId: '', notes: [] };

// ── Tasks state ────────────────────────────────────────────────
let tasksData = [];

// ── App switcher state ────────────────────────────────────────
let appWindows = [];
let appWindowsLoading = false;
let appFavorites = parseAppFavorites(localStorage.getItem('appFavorites') || '[]');

// ── DOM refs: mic ─────────────────────────────────────────────
const micBtn = $('mic-btn');
const ring = $('ring');
const ring2 = $('ring2');
const glow = $('glow');
const label = $('status-label');
const micContext = $('mic-context');
const svgOn = $('svg-on');
const svgOff = $('svg-off');

// ── DOM refs: status ──────────────────────────────────────────
const statusDot = $('status-dot');

// ── DOM refs: volume / audio ──────────────────────────────────
const volSlider = $('vol-slider');
const volVal = $('vol-val');
const spkName = $('spk-name');
const micName = $('mic-name');
const micVolSlider = $('mic-vol-slider');
const micVolTrack = micVolSlider ? micVolSlider.closest('.mic-vol-track') : null;
const micVolVal = $('mic-vol-val');
const volMuteBtn = $('vol-mute-btn');
const spkIconOn = $('spk-icon-on');
const spkIconOff = $('spk-icon-off');

// ── DOM refs: picker ──────────────────────────────────────────
const pickerOverlay = $('picker-overlay');
const pickerTitle = $('picker-title');
const pickerList = $('picker-list');
