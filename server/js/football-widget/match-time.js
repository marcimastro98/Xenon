// How the football tile writes when a match is played: its date and time, short and long, how far
// away it is, the matches grouped by day, and the match the tile leads with.
'use strict';

(() => {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function matchDate(ev) {
    if (!ev) return null;
    const iso = ev.ts || (ev.date ? ev.date + 'T' + (ev.time || '00:00:00') : '');
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  function matchMs(ev) { const d = matchDate(ev); return d ? d.getTime() : 0; }

  function timeText(ev) {
    const d = matchDate(ev);
    if (!d) return '';
    try { return d.toLocaleTimeString([], timeParts()); } catch { return ''; }
  }

  function whenShort(ev) {
    const d = matchDate(ev);
    if (!d) return '';
    try {
      const now = new Date();
      const days = Math.round((d - now) / 86400000);
      if (days >= 0 && days <= 6) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], timeParts());
      return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
    } catch { return ''; }
  }

  function whenLong(ev) {
    const d = matchDate(ev);
    if (!d) return '';
    try { return d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }) + ' · ' + d.toLocaleTimeString([], timeParts()); }
    catch { return ''; }
  }

  function relTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const s = Math.max(0, (Date.now() - n) / 1000);
    if (s < 60) return t('news_now', 'now');
    if (s < 3600) return Math.floor(s / 60) + t('news_min', 'm');
    if (s < 86400) return Math.floor(s / 3600) + t('news_hour', 'h');
    const d = Math.floor(s / 86400);
    if (d < 7) return d + t('news_day', 'd');
    try { return new Date(n).toLocaleDateString([], { day: '2-digit', month: 'short' }); } catch { return ''; }
  }

  // Buckets a merged feed into display groups. Anything finished goes to
  // RISULTATI however recent it is; anything still to play is grouped by its own
  // day, so "OGGI" never contains a match that has already been decided.
  function groupByDay(rows, now) {
    const startOf = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const today = startOf(now);
    const upcoming = [];
    const past = [];
    for (const r of rows) {
      const ms = matchMs(r.ev);
      const done = r.ev.status === 'ft' || (r.ev.status !== 'live' && ms && ms < now - 3 * 3600 * 1000);
      (done ? past : upcoming).push({ ...r, ms });
    }
    upcoming.sort((a, b) => (a.ms || 0) - (b.ms || 0));
    past.sort((a, b) => (b.ms || 0) - (a.ms || 0));

    const groups = [];
    let lastKey = null;
    for (const r of upcoming) {
      const day = r.ms ? startOf(r.ms) : 0;
      const key = 'd' + day;
      if (key !== lastKey) {
        lastKey = key;
        groups.push({ key, label: dayLabel(day, today), rows: [] });
      }
      groups[groups.length - 1].rows.push(r);
    }
    if (past.length) groups.push({ key: 'past', label: t('football_results', 'Results'), rows: past.slice(0, 8) });
    return groups;
  }

  function dayLabel(dayMs, todayMs) {
    if (!dayMs) return '';
    const diff = Math.round((dayMs - todayMs) / 86400000);
    if (diff === 0) return t('football_today', 'Today');
    if (diff === 1) return t('football_tomorrow', 'Tomorrow');
    try { return new Date(dayMs).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }); }
    catch { return ''; }
  }

  // The one match the tile leads with: in play, else the next one to kick off,
  // else the most recent result. Never an arbitrary favorite's fixture.
  function heroPick(rows, now) {
    let live = null, next = null, last = null;
    for (const r of rows) {
      const ms = matchMs(r.ev);
      if (r.ev.status === 'live') { if (!live || ms < matchMs(live.ev)) live = r; continue; }
      if (r.ev.status === 'ft' || (ms && ms < now - 3 * 3600 * 1000)) {
        if (!last || ms > matchMs(last.ev)) last = r;
      } else if (ms >= now - 3 * 3600 * 1000) {
        if (!next || ms < matchMs(next.ev)) next = r;
      }
    }
    return live || next || last || null;
  }

  window.FootballWidgetMatchTime = {
    t, timeText, whenShort, whenLong, relTime, groupByDay, heroPick,
  };
})();
