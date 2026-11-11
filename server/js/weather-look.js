// Which look the Weather tile wears: the 5.x tile (js/weather-tile.js) or the
// separate cards of Xenon 4.11 (js/weather-classic.js), Settings → Weather → Style
// and Bit's change_setting weather_style. The classic files load the first time
// someone picks it, so nobody else downloads them; if they cannot load, the tile
// stays on the new look and says nothing worse than that.
(() => {
  'use strict';

  const LOOKS = ['new', 'classic'];
  const CLASSIC_JS = 'js/weather-classic.js';
  const CLASSIC_CSS = 'components/WeatherTile/WeatherClassic.css';
  let classicLoad = null;

  function current() {
    const w = (typeof hubSettings === 'object' && hubSettings && hubSettings.weather) || {};
    const look = w.tile && w.tile.look;
    return LOOKS.includes(look) ? look : 'new';
  }

  function loaded(el) {
    return new Promise((resolve, reject) => {
      el.addEventListener('load', resolve, { once: true });
      el.addEventListener('error', () => reject(new Error(`could not load ${el.src || el.href}`)), { once: true });
    });
  }

  // Both files, stylesheet first, so the cards never draw unstyled.
  function loadClassic() {
    if (window.WeatherClassic) return Promise.resolve();
    if (classicLoad) return classicLoad;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = CLASSIC_CSS;
    const js = document.createElement('script');
    js.src = CLASSIC_JS;
    const ready = Promise.all([loaded(css), loaded(js)]);
    document.head.append(css, js);
    classicLoad = ready.catch((err) => {
      classicLoad = null;
      css.remove();
      js.remove();
      throw err;
    });
    return classicLoad;
  }

  // True when the classic look drew the tile; false leaves it to the new one.
  // A first call starts the load and draws again once it is in.
  function render(mounts, data, sec) {
    if (current() !== 'classic') return false;
    if (!window.WeatherClassic) {
      loadClassic()
        .then(() => { if (typeof renderWeatherTile === 'function') renderWeatherTile(); })
        .catch((err) => console.warn('[weather] classic look unavailable, showing the new one:', err.message));
      return false;
    }
    mounts.forEach((mount) => window.WeatherClassic.render(mount, data, sec));
    return true;
  }

  function sync() {
    const look = current();
    document.querySelectorAll('[data-weather-look]').forEach((btn) => {
      const on = btn.dataset.weatherLook === look;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  // Same path as the other Weather settings: normalize, save, redraw.
  function set(look) {
    if (!LOOKS.includes(look) || look === current() || typeof normalizeSettings !== 'function') return;
    const tile = normalizeWeatherTile(hubSettings.weather && hubSettings.weather.tile);
    hubSettings = normalizeSettings({ ...hubSettings, weather: { ...hubSettings.weather, tile: { ...tile, look } } });
    if (typeof commitWeatherChange === 'function') commitWeatherChange();
    sync();
    if (typeof renderWeatherTile === 'function') renderWeatherTile();
    if (typeof setSettingsStatus === 'function') setSettingsStatus('settings_weather_saved', 'ok');
  }

  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-weather-look]') : null;
    if (btn) set(btn.dataset.weatherLook);
  });

  window.WeatherLook = { LOOKS, current, render, set, sync };
})();
