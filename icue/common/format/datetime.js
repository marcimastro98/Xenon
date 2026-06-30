/*
 * Locale-aware date/time formatting. Plain script, inlined at build time.
 * Uses the platform Intl APIs so output respects the user's iCUE language.
 */

/* Break a Date into display parts for a clock.
 *   mode: 'system' (locale default) | '12' (force 12h) | '24' (force 24h)
 * Returns zero-padded { hour, minute, second, dayPeriod } strings;
 * `second` is "" when showSeconds is false, `dayPeriod` is "" in 24h. */
function formatClockParts(date, mode, showSeconds, locale) {
  var options = { hour: "2-digit", minute: "2-digit" };
  if (showSeconds) options.second = "2-digit";
  if (mode === "12") options.hour12 = true;
  else if (mode === "24") options.hour12 = false;
  // 'system' leaves hour12 unset so the locale decides (e.g. en → 12h, it → 24h).

  var parts = new Intl.DateTimeFormat(locale || "en", options).formatToParts(date);
  var out = { hour: "", minute: "", second: "", dayPeriod: "" };
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.type === "hour") out.hour = p.value;
    else if (p.type === "minute") out.minute = p.value;
    else if (p.type === "second") out.second = p.value;
    else if (p.type === "dayPeriod") out.dayPeriod = p.value;
  }
  return out;
}

/* Long localized date, e.g. "Monday 30 June" / "lunedì 30 giugno". */
function formatLongDate(date, locale) {
  return new Intl.DateTimeFormat(locale || "en", {
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(date);
}
