'use strict';

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

  $('clock-h').textContent = hDisplay;
  $('clock-m').textContent = String(mins).padStart(2, '0');
  const ampmEl = $('clock-ampm');
  if (ampmEl) ampmEl.textContent = ampm;

  $('clock-date').textContent = new Intl.DateTimeFormat(locale, {
    weekday: 'long', day: '2-digit', month: 'long'
  }).format(now);
}
