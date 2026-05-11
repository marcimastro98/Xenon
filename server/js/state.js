'use strict';

// ── Server ───────────────────────────────────────────────────
const SERVER = 'http://127.0.0.1:3030';

// ── Mic state ────────────────────────────────────────────────
let muted = false;
let busy = false;

// ── Debounce timers ──────────────────────────────────────────
let volDebounce = null;
let micVolDebounce = null;

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
let lang = localStorage.getItem('uiLang') || (((navigator.language || '').toLowerCase().startsWith('it')) ? 'it' : 'en');
if (lang !== 'it' && lang !== 'en') lang = 'it';

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
let notesLoaded = false;

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
