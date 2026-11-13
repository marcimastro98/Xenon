// Small pieces every weather provider's answer is turned into: how many days, the condition
// groups with their words, compass points, clock and date parts.

// Max days the "next days" forecast can request/return. The forecast is cached
// per-location and doesn't know the per-client day preference, so the server
// always fetches up to this many and the client trims to the user's choice (1–7).
// Open-Meteo/met.no cover 7 easily; wttr.in only exposes 3 (harmless — slicing a
// shorter list is a no-op and the UI just shows what's available).
const WEATHER_FORECAST_MAX_DAYS = 7;

// Canonical condition buckets → a representative wttr (WWO) code the client's
// classifier already understands, plus a localized label. Providers map their
// own codes to a bucket, so icons, day/night and colours work with no client
// change. Labels cover every UI language in WEATHER_LANGS (fallback: English) —
// keep the two in step when adding a language, or that language's users get
// mixed-language conditions (#72).
const WEATHER_BUCKET_CODE = Object.freeze({
  clear: 113, partly: 116, cloud: 119, fog: 248,
  drizzle: 266, rain: 302, showers: 356, snow: 338, storm: 200,
});
const WEATHER_BUCKET_LABELS = Object.freeze({
  it: { clear: 'Sereno', partly: 'Poco nuvoloso', cloud: 'Nuvoloso', fog: 'Nebbia', drizzle: 'Pioviggine', rain: 'Pioggia', showers: 'Rovesci', snow: 'Neve', storm: 'Temporale' },
  en: { clear: 'Clear', partly: 'Partly cloudy', cloud: 'Cloudy', fog: 'Fog', drizzle: 'Drizzle', rain: 'Rain', showers: 'Showers', snow: 'Snow', storm: 'Thunderstorm' },
  ko: { clear: '맑음', partly: '구름 조금', cloud: '흐림', fog: '안개', drizzle: '이슬비', rain: '비', showers: '소나기', snow: '눈', storm: '뇌우' },
  ja: { clear: '快晴', partly: '晴れ時々曇り', cloud: '曇り', fog: '霧', drizzle: '霧雨', rain: '雨', showers: 'にわか雨', snow: '雪', storm: '雷雨' },
  zh: { clear: '晴', partly: '多云', cloud: '阴', fog: '雾', drizzle: '毛毛雨', rain: '雨', showers: '阵雨', snow: '雪', storm: '雷暴' },
  es: { clear: 'Despejado', partly: 'Parcialmente nublado', cloud: 'Nublado', fog: 'Niebla', drizzle: 'Llovizna', rain: 'Lluvia', showers: 'Chubascos', snow: 'Nieve', storm: 'Tormenta' },
  fr: { clear: 'Dégagé', partly: 'Partiellement nuageux', cloud: 'Nuageux', fog: 'Brouillard', drizzle: 'Bruine', rain: 'Pluie', showers: 'Averses', snow: 'Neige', storm: 'Orage' },
  de: { clear: 'Klar', partly: 'Teilweise bewölkt', cloud: 'Bewölkt', fog: 'Nebel', drizzle: 'Nieselregen', rain: 'Regen', showers: 'Schauer', snow: 'Schnee', storm: 'Gewitter' },
  pt: { clear: 'Céu limpo', partly: 'Parcialmente nublado', cloud: 'Nublado', fog: 'Nevoeiro', drizzle: 'Chuvisco', rain: 'Chuva', showers: 'Aguaceiros', snow: 'Neve', storm: 'Trovoada' },
  ru: { clear: 'Ясно', partly: 'Переменная облачность', cloud: 'Облачно', fog: 'Туман', drizzle: 'Морось', rain: 'Дождь', showers: 'Ливни', snow: 'Снег', storm: 'Гроза' },
  nl: { clear: 'Helder', partly: 'Gedeeltelijk bewolkt', cloud: 'Bewolkt', fog: 'Mist', drizzle: 'Motregen', rain: 'Regen', showers: 'Buien', snow: 'Sneeuw', storm: 'Onweer' },
});
function weatherBucketLabel(bucket, lang) {
  const table = WEATHER_BUCKET_LABELS[lang] || WEATHER_BUCKET_LABELS.en;
  return table[bucket] || WEATHER_BUCKET_LABELS.en[bucket] || '';
}
function degToCompass(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return '';
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(((n % 360) + 360) % 360 / 22.5) % 16];
}
// ISO8601 local time (e.g. "2026-07-01T05:38") → "HH:MM" for display + the
// client's night detector (parseSunTime also accepts 24h times).
function isoToClock(iso) {
  const m = String(iso || '').match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}
function isoDatePart(iso) {
  const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

module.exports = {
  WEATHER_FORECAST_MAX_DAYS, WEATHER_BUCKET_CODE, WEATHER_BUCKET_LABELS, weatherBucketLabel,
  degToCompass, isoToClock, isoDatePart,
};
