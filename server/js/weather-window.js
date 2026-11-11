'use strict';

// The Weather window: the tile's parts at full size, in the order a forecast is read: now,
// the next hours, the next days, the details. The parts come from js/weather-tile.js, so the
// two never disagree. js/system.js opens and closes it; the tile, the top bar and Bit ask.

// A wrong city or no location is fixed in Settings; a service that is down fixes itself.
const WEATHER_SETTINGS_ERRORS = new Set(['no_location', 'city_not_found']);

function weatherSunFacts(data) {
  return [['weather_sunrise', data.sunrise], ['weather_sunset', data.sunset]]
    .map(([key, time]) => ({ key, min: parseSunTime(time) }))
    .filter(({ min }) => min != null)
    .map(({ key, min }) => ({ key, value: weatherClockText(min), warn: false }));
}

function buildWeatherWindowNow(data) {
  const now = weatherEl('div', 'weather-win-now');
  const lines = weatherEl('div', 'weather-win-lines');
  lines.append(weatherEl('span', 'weather-win-condition', data.condition || t('weather_title')), buildWeatherNowFacts(data));
  now.append(
    weatherEl('span', 'weather-win-temp', `${toDisplayTemp(data.tempC)}°`),
    lines,
    weatherArtEl('weather-win-art', classifyWeatherState(data), isWeatherNight(data.sunrise, data.sunset)),
  );
  const next = weatherNextLine(data, weatherHourRows(data));
  if (next) {
    const line = weatherEl('p', 'weather-win-next', next.text);
    line.classList.toggle('is-wet', next.wet);
    now.appendChild(line);
  }
  return now;
}

function buildWeatherWindowBlock(name, titleKey, part) {
  if (!part) return null;
  const block = weatherEl('section', `weather-win-block weather-win-${name}`);
  const well = weatherEl('div', 'weather-win-well');
  well.appendChild(part);
  block.append(weatherEl('h3', 'weather-win-heading', t(titleKey)), well);
  return block;
}

function buildWeatherWindowBody(data) {
  const days = Array.isArray(data.forecast) && data.forecast.length ? buildWeatherDays(data) : null;
  const main = weatherEl('div', 'weather-win-main');
  const side = weatherEl('div', 'weather-win-side');
  main.append(...[
    buildWeatherWindowNow(data),
    buildWeatherWindowBlock('hours', 'weather_hourly', buildWeatherHours(data)),
    buildWeatherWindowBlock('days', 'weather_forecast', days),
  ].filter(Boolean));
  side.append(...[
    buildWeatherWindowBlock('facts', 'weather_details_title', buildWeatherFacts(data, weatherSunFacts(data))),
  ].filter(Boolean));
  return [main, side];
}

function buildWeatherWindowSettingsKey() {
  const key = weatherEl('button', 'weather-win-key', t('weather_open_settings'));
  key.type = 'button';
  key.addEventListener('click', () => {
    closeWeatherDetails();
    openSettings('weather');
  });
  return key;
}

// What went wrong and what to do. The refresh key in the head stays the way to try again.
function buildWeatherWindowTrouble(data) {
  const box = weatherEl('div', 'weather-win-trouble');
  box.append(
    weatherArtEl('weather-win-art', 'state-offline', false),
    weatherEl('p', 'weather-win-trouble-title', weatherErrorLabel(data)),
    weatherEl('p', 'weather-win-trouble-hint', weatherErrorHint(data)),
  );
  if (data && WEATHER_SETTINGS_ERRORS.has(data.error) && typeof openSettings === 'function') {
    box.appendChild(buildWeatherWindowSettingsKey());
  }
  return box;
}

function buildWeatherWindowWaiting() {
  const box = weatherEl('div', 'weather-win-trouble');
  box.appendChild(weatherEl('p', 'weather-win-trouble-hint', t('weather_loading')));
  return box;
}

function weatherWindowParts(data) {
  if (data && data.ok) return buildWeatherWindowBody(data);
  return [!data && fetchingWeather ? buildWeatherWindowWaiting() : buildWeatherWindowTrouble(data)];
}

function renderWeatherDetails() {
  const overlay = $('weather-overlay');
  if (!overlay || overlay.hidden) return;
  const data = weatherData;
  const ok = !!(data && data.ok);
  const updated = $('weather-modal-updated');
  $('weather-modal-title').textContent = ok ? weatherFullPlace(data) : t('weather_title');
  updated.textContent = ok ? formatWeatherUpdated(data.updatedAt) : '';
  updated.classList.toggle('is-stale', ok && !!data.stale);
  $('weather-content').replaceChildren(...weatherWindowParts(data));
}

// Never disabled while it works: a disabled key would drop the focus out of the window.
async function refreshWeatherWindow(key) {
  key.setAttribute('aria-busy', 'true');
  await fetchWeather();
  key.removeAttribute('aria-busy');
}
