'use strict';

// The weather pictures of the Ambient scene and the Weather tile: one small drawing per sky state, lit
// from the top left like the glass around them. Still on purpose: the scene runs for hours
// and the old art kept eight loops going. Static, trusted markup: never built from data.
(function () {
  if (typeof window === 'undefined') return;

  const PAINT = `<defs>
<radialGradient id="wx-sun" cx=".36" cy=".3" r=".85"><stop offset="0" stop-color="#FFF3C4"/><stop offset=".5" stop-color="#FFCE5A"/><stop offset="1" stop-color="#FF9538"/></radialGradient>
<radialGradient id="wx-halo"><stop offset=".42" stop-color="#FFC55A" stop-opacity=".42"/><stop offset="1" stop-color="#FFC55A" stop-opacity="0"/></radialGradient>
<linearGradient id="wx-moon" x1=".15" y1="0" x2=".85" y2="1"><stop offset="0" stop-color="var(--sky-moon-top, #FBF7E6)"/><stop offset="1" stop-color="var(--sky-moon-low, #B6C4E8)"/></linearGradient>
<radialGradient id="wx-moon-halo"><stop offset=".4" stop-color="#AFC4F5" stop-opacity=".32"/><stop offset="1" stop-color="#AFC4F5" stop-opacity="0"/></radialGradient>
<linearGradient id="wx-cloud" x1=".2" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="var(--sky-cloud-top, #FFFFFF)"/><stop offset="1" stop-color="var(--sky-cloud-low, #C4D1E8)"/></linearGradient>
<linearGradient id="wx-cloud-dark" x1=".2" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#C9D2E4"/><stop offset="1" stop-color="#76839F"/></linearGradient>
</defs>`;

  const CLOUD = 'M29 72h40a15.5 15.5 0 0 0 3-30.7A22 22 0 0 0 30.2 36.6 17.8 17.8 0 0 0 29 72Z';
  const LOW_CLOUD = 'M29 60h40a15.5 15.5 0 0 0 3-30.7A22 22 0 0 0 30.2 24.6 17.8 17.8 0 0 0 29 60Z';
  const MOON_PATH = 'M58 20a28 28 0 1 0 19 44 24 24 0 0 1-19-44Z';

  const sun = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r * 1.75}" fill="url(#wx-halo)"/><circle cx="${x}" cy="${y}" r="${r}" fill="url(#wx-sun)"/>`;
  const moon = (scale, dx, dy) => `<g transform="translate(${dx} ${dy}) scale(${scale})"><circle cx="46" cy="46" r="42" fill="url(#wx-moon-halo)"/><path d="${MOON_PATH}" fill="url(#wx-moon)"/></g>`;
  const cloud = (path, paint) => `<path d="${path}" fill="url(#${paint})"/>`;
  const behind = (night) => (night ? moon(0.56, 40, 2) : sun(64, 28, 14));
  const drops = '<g stroke="var(--sky-drop, #8FCBFF)" stroke-width="4.6" stroke-linecap="round"><path d="M36 69l-4 10"/><path d="M50 69l-4 10"/><path d="M64 69l-4 10"/></g>';
  const flakes = '<g fill="var(--sky-flake, #EAF3FF)"><circle cx="33" cy="72" r="3.2"/><circle cx="48" cy="79" r="3.2"/><circle cx="63" cy="72" r="3.2"/><circle cx="41" cy="86" r="2.6"/><circle cx="56" cy="87" r="2.6"/></g>';
  const bolt = '<path d="M52 56 39 76h9.5l-5 15L60 70h-9.5l7-14Z" fill="#FFD25E"/>';
  const haze = '<g stroke="var(--sky-haze, #E4EBF7)" stroke-width="4.6" stroke-linecap="round"><path d="M22 70h52" opacity=".85"/><path d="M30 80h42" opacity=".6"/></g>';

  const DRAWINGS = {
    'state-sun': () => sun(48, 48, 28),
    'state-moon': () => moon(1, 2, 2),
    'state-cloud': (night) => behind(night) + cloud(CLOUD, 'wx-cloud'),
    'state-rain': (night) => behind(night) + cloud(LOW_CLOUD, 'wx-cloud') + drops,
    'state-storm': () => cloud(LOW_CLOUD, 'wx-cloud-dark') + bolt,
    'state-snow': (night) => behind(night) + cloud(LOW_CLOUD, 'wx-cloud') + flakes,
    'state-fog': () => cloud(LOW_CLOUD, 'wx-cloud') + haze,
  };

  // The --sky-* colours let a light sheet darken what is drawn for a dark sky.
  // Each drawing owns its gradients: url(#id) finds the first match in the document, and
  // Chromium paints nothing when that one sits in a hidden page or a closed lock screen.
  let drawn = 0;

  // state: a class from classifyWeatherState. Anything else (no reading yet) is a plain cloud.
  function svg(state, night) {
    const draw = DRAWINGS[state];
    const inner = draw ? draw(!!night) : cloud(CLOUD, 'wx-cloud-dark');
    drawn += 1;
    return `<svg viewBox="0 0 96 96" aria-hidden="true">${PAINT}${inner}</svg>`.replace(/wx-/g, `wx${drawn}-`);
  }

  window.WeatherArt = Object.freeze({ svg });
})();
