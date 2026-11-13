// Checks the saved choice of the screen Xenon runs on, and finds it in settings saved under its
// old name.

// The screen the user chose for Xenon. Mirrors normalizeSurface in
// js/settings.js key for key — the client owns this one, and a drift between the
// two halves is what silently resets a key on every save.
const SURFACE_KINDS = ['auto', 'screen', 'phone', 'both'];
function normalizeSurfaceChoice(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    kind: SURFACE_KINDS.includes(v.kind) ? v.kind : 'auto',
    asked: v.asked === true,
    monitor: typeof v.monitor === 'string' ? v.monitor.slice(0, 256) : '',
    label: typeof v.label === 'string' ? v.label.slice(0, 120) : '',
  };
}

// The screen choice used to be stored as `surface`, which is ALSO the name of
// the theme's main panel colour — and both were assigned in the same object
// literal of normalizeHubSettings, so the later one won and every save replaced
// the colour with `{kind, asked, monitor, label}`. Two features, one key, no
// error: the theme role was silently destroyed, and Settings then threw
// `val.toUpperCase is not a function` and stopped rendering, taking with it
// every panel mounted after that line (paired devices, file transfer, the
// Sunshine wizard, Streaming, Spotify, Smart Home, Cameras, external calendars).
//
// The choice moved to `surfaceChoice` rather than the colour moving, because the
// colour is the entrenched one: it is a theme-code field, a preset-sharing field
// and a CSS variable mapping, and renaming it would break every shared theme in
// existence. This reads the old spelling once so a machine that already stored
// the object keeps its screen, and the corrupted colour goes back to auto.
function surfaceChoiceFrom(source) {
  const s = source && typeof source === 'object' ? source : {};
  if (s.surfaceChoice && typeof s.surfaceChoice === 'object') return s.surfaceChoice;
  // A legacy value is an OBJECT under `surface`; a real colour there is a string
  // and must never be read as a screen choice.
  if (s.surface && typeof s.surface === 'object') return s.surface;
  return null;
}

module.exports = { SURFACE_KINDS, normalizeSurfaceChoice, surfaceChoiceFrom };
