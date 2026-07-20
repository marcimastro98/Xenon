'use strict';
(function () {
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };

  let timer = null;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="digitalclock"]'));
  }

  function paint(mount) {
    const wrap = el('div', 'dclock-wrap');
    
    const timeRow = el('div', 'dclock-time-row');
    const hourEl = el('span', 'dclock-hour');
    const colonEl = el('span', 'dclock-colon', ':');
    const minEl = el('span', 'dclock-min');
    const ampmEl = el('span', 'dclock-ampm');
    timeRow.appendChild(hourEl);
    timeRow.appendChild(colonEl);
    timeRow.appendChild(minEl);
    timeRow.appendChild(ampmEl);

    const dateEl = el('div', 'dclock-date');
    
    wrap.appendChild(timeRow);
    wrap.appendChild(dateEl);
    
    mount.replaceChildren(wrap);
    
    // Initial update
    updateClock(hourEl, minEl, ampmEl, dateEl);
    
    // Store references for the tick
    mount._dcHour = hourEl;
    mount._dcMin = minEl;
    mount._dcAmpm = ampmEl;
    mount._dcDate = dateEl;
  }

  function updateClock(hourEl, minEl, ampmEl, dateEl) {
    const now = new Date();
    
    // 12-hour format with AM/PM
    let h24 = now.getHours();
    let m = now.getMinutes();
    let h12 = h24 % 12 || 12;
    let ampm = h24 >= 12 ? 'PM' : 'AM';
    
    const hStr = h12.toString().padStart(2, '0');
    const mStr = m.toString().padStart(2, '0');
    
    if (hourEl.textContent !== hStr) hourEl.textContent = hStr;
    if (minEl.textContent !== mStr) minEl.textContent = mStr;
    if (ampmEl.textContent !== ampm) ampmEl.textContent = ampm;

    // DD/MM/YYYY format
    const d = now.getDate().toString().padStart(2, '0');
    const mo = (now.getMonth() + 1).toString().padStart(2, '0');
    const y = now.getFullYear();
    const dateStr = `${d}/${mo}/${y}`;
    
    if (dateEl.textContent !== dateStr) dateEl.textContent = dateStr;
  }

  function tick() {
    const ts = tiles();
    if (ts.length === 0) return;
    
    ts.forEach(tile => {
      const mount = tile.querySelector('.digitalclock-widget-mount');
      if (mount && mount._dcHour) {
        updateClock(mount._dcHour, mount._dcMin, mount._dcAmpm, mount._dcDate);
      }
    });
  }

  function renderWidgets() {
    const ts = tiles();
    if (!ts.length) {
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }
    
    ts.forEach(tile => {
      const mount = tile.querySelector('.digitalclock-widget-mount');
      if (mount && !mount.querySelector('.dclock-wrap')) {
        paint(mount);
      }
    });

    if (!timer) {
      timer = setInterval(tick, 1000);
    }
  }

  window.DigitalClockWidget = { renderWidgets };
})();
