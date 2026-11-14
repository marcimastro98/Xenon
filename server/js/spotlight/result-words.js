// How search writes a size, a date and a folder, the label of each chip it read out of the query,
// and the words its filter menu types.
'use strict';

(() => {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function fmtSize(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = n, i = -1;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 10 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  }

  // Dates follow the dashboard's language, not the browser's: an English Xenon
  // on an Italian Windows was labelling a chip "dicembre 2025". Guarded because
  // t() echoes the key back when a dict is missing it, and a bogus locale tag
  // makes toLocaleDateString throw.
  function dateLocale() {
    const l = t('locale', '');
    return /^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/.test(l) ? l : undefined;
  }

  function fmtDate(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms), now = new Date();
    const days = Math.floor((now - d) / 86400000);
    if (days <= 0) return t('spot_today', 'oggi');
    if (days === 1) return t('spot_yesterday', 'ieri');
    if (days < 30) return days + ' ' + t('spot_days_ago', 'giorni fa');
    return d.toLocaleDateString(dateLocale());
  }

  function shortDir(dir) {
    return String(dir || '').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~');
  }

  function chipLabel(c) {
    if (c.type === 'kind') {
      return t('spot_kind_' + c.kind, { image: 'Foto', video: 'Video', audio: 'Musica', document: 'Documenti', archive: 'Archivi' }[c.kind] || c.kind);
    }
    if (c.type === 'ext') return (c.exts || []).map((e) => '.' + e).join(' ');
    if (c.type === 'size') return (c.dir === 'min' ? '≥ ' : '≤ ') + fmtSize(c.bytes);
    if (c.type === 'date') {
      const K = {
        today: t('spot_today', 'oggi'), yesterday: t('spot_yesterday', 'ieri'),
        thisWeek: t('spot_this_week', 'questa settimana'), lastWeek: t('spot_last_week', 'settimana scorsa'),
        thisMonth: t('spot_this_month', 'questo mese'), lastMonth: t('spot_last_month', 'mese scorso'),
        thisYear: t('spot_this_year', 'quest’anno'), lastYear: t('spot_last_year', 'anno scorso'),
        recent: t('spot_recent', 'recenti'),
      };
      if (K[c.key]) return K[c.key];
      if (c.key === 'month') {
        const d = new Date(c.year, c.month, 1);
        return d.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' });
      }
      if (c.key === 'year') return String(c.year);
      if (c.key === 'lastN') return t('spot_last_n', 'ultimi') + ' ' + c.n + ' ' + t('spot_unit_' + c.unit, c.unit);
      if (c.key === 'range') {
        // AI-produced explicit date bounds: shown as plain local dates.
        const f = (ms) => new Date(ms).toLocaleDateString(dateLocale());
        if (c.after != null && c.before != null) return f(c.after) + ' – ' + f(c.before);
        if (c.after != null) return t('spot_from', 'dal') + ' ' + f(c.after);
        if (c.before != null) return t('spot_until', 'fino al') + ' ' + f(c.before);
      }
      return '';
    }
    return '';
  }

  // A filter is typed into the query rather than kept apart, so it shows as the
  // same removable chip a typed "foto" or "questo mese" does, and the query
  // stays one string the user can read and edit. The parser speaks Italian and
  // English; other languages get the English words.
  const FILTER_WORDS = {
    it: { image: 'foto', video: 'video', audio: 'musica', document: 'documenti', archive: 'archivi',
      today: 'oggi', week: 'questa settimana', month: 'questo mese', year: "quest'anno",
      big: 'più di 100 mb', huge: 'più di 1 gb' },
    en: { image: 'photos', video: 'videos', audio: 'music', document: 'documents', archive: 'archives',
      today: 'today', week: 'this week', month: 'this month', year: 'this year',
      big: 'more than 100 mb', huge: 'more than 1 gb' },
  };

  function filterWords() {
    // `lang` is i18n.js's global (a script-level let, not a window property).
    const l = typeof lang !== 'undefined' ? lang : 'en';
    return FILTER_WORDS[l === 'it' ? 'it' : 'en'];
  }

  const FILTER_GROUPS = [
    ['spot_filter_type', 'Tipo', [['image', 'spot_kind_image', 'Foto'], ['video', 'spot_kind_video', 'Video'], ['audio', 'spot_kind_audio', 'Musica'], ['document', 'spot_kind_document', 'Documenti'], ['archive', 'spot_kind_archive', 'Archivi']]],
    ['spot_filter_date', 'Modificati', [['today', 'spot_today', 'oggi'], ['week', 'spot_this_week', 'questa settimana'], ['month', 'spot_this_month', 'questo mese'], ['year', 'spot_this_year', 'quest’anno']]],
    ['spot_filter_size', 'Dimensione', [['big', 'spot_filter_big', 'Oltre 100 MB'], ['huge', 'spot_filter_huge', 'Oltre 1 GB']]],
  ];

  window.SpotlightResultWords = {
    t, fmtSize, fmtDate, shortDir, chipLabel, filterWords, FILTER_GROUPS,
  };
})();
