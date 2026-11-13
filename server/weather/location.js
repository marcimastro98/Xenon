// Cleans a typed city and picks the place a weather search meant.

function sanitizeWeatherCity(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>`"'\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeWeatherLocation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : 'auto';
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
  };
}

function resolveWeatherLocation(value) {
  const location = normalizeWeatherLocation(value);
  if (location.mode === 'manual' && location.city) return location;
  return { mode: 'auto', city: '' };
}

function normalizeWeatherCityKey(value) {
  return sanitizeWeatherCity(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function pickWeatherLocationResult(results, requestedCity) {
  if (!Array.isArray(results) || !results.length) return null;
  const requestedKey = normalizeWeatherCityKey(requestedCity);
  return results.find(item => normalizeWeatherCityKey(item && item.name) === requestedKey)
    || results.find(item => requestedKey.startsWith(normalizeWeatherCityKey(item && item.name)))
    || results.find(item => normalizeWeatherCityKey(item && item.name).startsWith(requestedKey))
    || results[0];
}

function splitWeatherDisplayLocation(value) {
  const parts = String(value || '').split(',').map(part => part.trim()).filter(Boolean);
  return {
    location: parts[0] || '',
    region: parts[1] || '',
    country: parts.slice(2).join(', '),
  };
}

module.exports = {
  sanitizeWeatherCity, normalizeWeatherLocation, resolveWeatherLocation, normalizeWeatherCityKey,
  pickWeatherLocationResult, splitWeatherDisplayLocation,
};
