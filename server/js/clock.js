'use strict';

// tickClock runs once a second, but the hour/minute change once a minute and the
// date once a day. Cache the date formatter per locale and skip DOM writes whose
// value hasn't changed — avoids ~86k throwaway Intl.DateTimeFormat allocations/day
// and 4 needless textContent writes every second.
let _dateFmt = null, _dateFmtLocale = null;
let _lastH = null, _lastM = null, _lastAmpm = null, _lastDate = null;

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

  if (locale !== _dateFmtLocale) {
    _dateFmt = new Intl.DateTimeFormat(locale, { weekday: 'long', day: '2-digit', month: 'long' });
    _dateFmtLocale = locale;
    _lastDate = null;   // force a re-write on locale change
  }
  const dateStr = _dateFmt.format(now);
  if (dateStr !== _lastDate) { $('clock-date').textContent = dateStr; _lastDate = dateStr; }
}
