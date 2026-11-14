// The words on a history chart: a bucket's key as a date, the hour in the user's clock, the day,
// the label of a tick, the moment a crosshair stands on, and a value with its unit.
'use strict';

(() => {
  function locale() {
    return (typeof i18n === 'object' && typeof lang === 'string' && i18n[lang] && i18n[lang].locale) || undefined;
  }

  // 'YYYY-MM-DDTHH:MM' (single samples), 'YYYY-MM-DDTHH' or 'YYYY-MM-DD' to a
  // Date, in local time like the keys.
  function bucketDate(t) {
    const [day, time] = String(t || '').split('T');
    const [y, m, d] = day.split('-').map(Number);
    if (!y || !m || !d) return null;
    const [hh, mm] = String(time || '').split(':').map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0);
  }

  const hasMinutes = (t) => /T\d{2}:\d{2}$/.test(String(t || ''));

  // The hour in the user's clock (Settings → Time format, through utils/time-and-format.js
  // plainHourParts): bare on the axis ("17", "5 PM"), with its minutes where it
  // stands alone over the chart ("17:00", "5:00 PM").
  function hourText(date, minutes = false) {
    try {
      return date.toLocaleTimeString(locale(), plainHourParts({ minutes }));
    } catch {
      return minutes ? `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}` : String(date.getHours());
    }
  }

  function dayText(date, opts) {
    try { return date.toLocaleDateString(locale(), opts || { day: 'numeric', month: 'short' }); } catch { return `${date.getDate()}/${date.getMonth() + 1}`; }
  }

  // An axis label. Hourly buckets show the hour in the user's clock; when the
  // range crosses midnight the two ends also carry their day, so "9 PM" on the
  // left and "8 PM" on the right do not read as one hour going backwards.
  function tickText(t, withDay) {
    const date = bucketDate(t);
    if (!date) return String(t || '');
    if (!String(t).includes('T')) return dayText(date);
    const time = hourText(date, hasMinutes(t));
    return withDay ? `${dayText(date)}, ${time}` : time;
  }

  // The moment a crosshair stands on, in full enough words to place it.
  function whenText(t) {
    const date = bucketDate(t);
    if (!date) return String(t || '');
    if (!String(t).includes('T')) return dayText(date, { weekday: 'short', day: 'numeric', month: 'short' });
    return `${dayText(date, { weekday: 'short' })} ${hourText(date, true)}`;
  }

  const fmt = (v, unit) => (v == null ? '--' : `${Math.round(v)}${unit}`);

  window.HistoryChartWords = { tickText, whenText, fmt };
})();
