'use strict';

// The weather glyphs: a minimal single-stroke icon per sky state, simpler than
// the lock screen's layered weather art. The Weather element of a canvas
// Ambient scene draws them (js/ambient-canvas-parts.js), on the dashboard and
// on the desktop scene page (scene.html), so they live apart from any one
// renderer. Static, trusted markup: never built from data.
(function () {
  if (typeof window === 'undefined') return;
  const WEATHER_ICONS = {
    sun:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.4"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19"/></svg>',
    moon:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18.5h9.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 5.4 11 3.8 3.8 0 0 0 7 18.5Z"/></svg>',
    rain:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15h9.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 5.4 7.5 3.8 3.8 0 0 0 7 15Z"/><path d="M8.5 18.2 8 20M12.2 18.2l-.5 1.8M15.9 18.2l-.5 1.8"/></svg>',
    storm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14h9.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 5.4 6.5 3.8 3.8 0 0 0 7 14Z"/><path d="m12.6 15-2.1 3.4h3l-2.1 3.4"/></svg>',
    snow:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15h9.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 5.4 7.5 3.8 3.8 0 0 0 7 15Z"/><path d="M8.6 18.4h.01M12.1 20h.01M15.6 18.4h.01"/></svg>',
    fog:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 10h16M6 14h13M4.5 18h14"/></svg>',
  };
  window.WeatherGlyphs = Object.freeze(WEATHER_ICONS);
})();
