'use strict';

// tickClock runs once a second, but the hour/minute change once a minute and the
// date once a day. Cache the date formatter per locale and skip DOM writes whose
// value hasn't changed — avoids ~86k throwaway Intl.DateTimeFormat allocations/day
// and 4 needless textContent writes every second.
let _dateFmt = null, _dateFmtLocale = null, _dateFmtShape = null;
let _lastH = null, _lastM = null, _lastAmpm = null, _lastDate = null;

// How much of the date the top bar spells out. Built from Intl options rather
// than by cutting the formatted string: every locale writes a date its own way
// (weekday first, month first, dots, no comma) and slicing one apart produces
// nonsense in ten of the eleven languages Xenon speaks. Asking Intl for less
// gets the SHORT form that locale actually uses.
//
// 'full' is what the bar has always shown, so it stays the default.
const CLOCK_DATE_SHAPES = Object.freeze({
  full:   { weekday: 'long',  day: '2-digit', month: 'long' },
  medium: { weekday: 'short', day: 'numeric', month: 'short' },
  short:  { day: '2-digit', month: '2-digit' },
});

function clockDateShape() {
  const s = (typeof hubSettings === 'object' && hubSettings) || {};
  const name = String(s.clockDateFormat || 'full');
  return Object.hasOwn(CLOCK_DATE_SHAPES, name) ? name : 'full';
}

function tickClock() {
  const now   = new Date();
  const locale = t('locale');

  // 12h vs 24h: user setting (Auto/12h/24h), Auto follows the UI language.
  const is12h = clockUses12h();
  const h24   = now.getHours();
  const mins  = now.getMinutes();

  let hDisplay, ampm;
  if (is12h) {
    const h12 = h24 % 12 || 12;
    hDisplay  = String(h12).padStart(2, '0');
    ampm      = h24 < 12 ? 'AM' : 'PM';
  } else {
    hDisplay  = String(h24).padStart(2, '0');
    ampm      = '';
  }

  if (hDisplay !== _lastH) { $('clock-h').textContent = hDisplay; _lastH = hDisplay; }
  const mStr = String(mins).padStart(2, '0');
  if (mStr !== _lastM) { $('clock-m').textContent = mStr; _lastM = mStr; }
  if (ampm !== _lastAmpm) {
    const ampmEl = $('clock-ampm');
    if (ampmEl) ampmEl.textContent = ampm;
    _lastAmpm = ampm;
  }

  // The formatter is cached per locale AND per shape: leaving the shape out of
  // the key is how a setting change would keep drawing the old date until the
  // language happened to change.
  const shape = clockDateShape();
  if (locale !== _dateFmtLocale || shape !== _dateFmtShape) {
    _dateFmt = new Intl.DateTimeFormat(locale, CLOCK_DATE_SHAPES[shape]);
    _dateFmtLocale = locale;
    _dateFmtShape = shape;
    _lastDate = null;   // force a re-write on locale or shape change
  }
  const dateStr = _dateFmt.format(now);
  if (dateStr !== _lastDate) { $('clock-date').textContent = dateStr; _lastDate = dateStr; }
}
