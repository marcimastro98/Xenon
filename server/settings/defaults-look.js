// What a new install starts with, first part: colours, style, glass, clock size and the lock
// screen's widgets.

const HUB_DEFAULTS_LOOK = Object.freeze({
  appearance: 'dark',
  autoPalette: false,
  styleMode: 'liquid', // 'liquid' | 'glass' | 'retro' | 'comic' — dashboard style language; a saved 'glass' stays Classic
  retroScanlines: true, // retro-only CRT scanline overlay sub-toggle
  accent: '#6ee787',
  dynamicAlbumTheme: true, // tint the accent from the now-playing album art
  background: '#14181c',
  surface: null,
  surfaceAlt: null,
  controlColor: null,
  text: '#f0f3f1',
  accentText: null,
  successColor: null,
  warningColor: null,
  dangerColor: null,
  infoColor: null,
  contrastGuard: true,
  panelAlpha: 0.54,
  bgDim: 0.48,
  bgBlur: 0,
  idleAnimationPause: true, // pause ambient FX + decorative loops when idle (client-applied)
  bootSplash: true, // the Xenon mark while the dashboard loads (client-applied)
  hybridGpuAnimationPause: true, // freeze ambient FX + animated bg + Deck decor on a hybrid-GPU native session (client-applied)
  // Extended theme tokens (full Aspetto editor). Defaults reproduce the stock
  // look; the client applies them (glass styles only). Mirror of settings.js.
  uiRoundness: 1,
  glassBlur: 22,
  glassSaturate: 160,
  clockScale: 1,
  clockDateScale: 1,
  clockDateFormat: 'medium',
  panelBorderStrength: 1,
  tileShadowStrength: 0,   // off, and renamed on purpose; see the client twin in js/settings.js
  mutedText: null,
  lineColor: null,
  backgroundMedia: null,
  uiFont: null,
  lockWidgets: Object.freeze({ clock: true, weather: true, media: true, calendar: true }),
});

module.exports = { HUB_DEFAULTS_LOOK };
