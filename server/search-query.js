'use strict';

// ── Local search: deterministic query parser (pure logic) ───────────────────
// Turns a phrase typed in normal language ("foto di dicembre", "pdf grandi",
// "invoice last month") into a structured filter the search backends execute:
// free-text terms, a file kind, explicit extensions, a modified-date range and
// a size range. This is the OFFLINE intelligence of the Spotlight — it runs on
// every keystroke with no AI and no network; the optional AI layer produces
// the same structure for harder phrasings, so everything downstream (Windows
// Search SQL, crawler-index filtering, ranking) has exactly one input shape.
//
// The parser also returns machine-readable CHIPS describing what it understood
// ("kind:image", "date:lastMonth", "size:min 100MB"). The client renders them
// localized and lets the user remove one with a tap; removal re-parses with
// that dimension disabled via `opts.disable` — the parser itself never guesses
// twice.
//
// Pure and deterministic: no Date.now() inside (callers pass `now`), no I/O,
// no state. UMD like sdk-perf.js so it is unit-testable under Node
// (test/search-query.test.mjs) and loadable by the client if ever needed.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.SearchQuery = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // File kinds and the extension sets they mean. Lowercase, no dots. These are
  // also what the ranker uses to judge type affinity, so they live here (one
  // owner) and are exported.
  const KIND_EXTS = {
    image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'svg', 'tif', 'tiff'],
    video: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'm4v'],
    audio: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'wma'],
    document: ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'md', 'rtf', 'odt', 'csv'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'iso'],
  };

  // Words that mean a kind (IT + EN, accent-stripped, matched as whole words).
  const KIND_WORDS = new Map([
    ...['foto', 'immagine', 'immagini', 'screenshot', 'screenshots', 'image', 'images',
      'photo', 'photos', 'picture', 'pictures', 'pic', 'pics'].map((w) => [w, 'image']),
    ...['video', 'videos', 'film', 'filmati', 'movie', 'movies'].map((w) => [w, 'video']),
    ...['musica', 'canzone', 'canzoni', 'brani', 'music', 'song', 'songs', 'audio'].map((w) => [w, 'audio']),
    ...['documento', 'documenti', 'document', 'documents'].map((w) => [w, 'document']),
    ...['archivio', 'archivi', 'archive', 'archives'].map((w) => [w, 'archive']),
  ]);

  // Words that mean specific extensions. A word can map to several (excel →
  // both xlsx and xls). Bare known extensions ("pdf", "png") count too, plus
  // any ".ext" token the user types explicitly.
  const EXT_WORDS = new Map([
    ['pdf', ['pdf']],
    ['excel', ['xlsx', 'xls']], ['spreadsheet', ['xlsx', 'xls', 'csv']],
    ['word', ['docx', 'doc']],
    ['powerpoint', ['pptx', 'ppt']], ['presentazione', ['pptx', 'ppt']], ['presentation', ['pptx', 'ppt']],
    ['csv', ['csv']], ['txt', ['txt']], ['markdown', ['md']], ['json', ['json']], ['xml', ['xml']],
    ['zip', ['zip']], ['rar', ['rar']], ['iso', ['iso']],
    ['png', ['png']], ['jpg', ['jpg', 'jpeg']], ['jpeg', ['jpg', 'jpeg']], ['gif', ['gif']],
    ['mp3', ['mp3']], ['mp4', ['mp4']], ['mkv', ['mkv']], ['wav', ['wav']], ['flac', ['flac']],
  ]);

  // Filler words dropped from the leftover terms. Includes search-intent verbs
  // ("cerca", "apri", "find") so "apri il contratto" leaves just "contratto".
  const STOPWORDS = new Set([
    // it
    'di', 'del', 'della', 'dello', 'dei', 'degli', 'delle', 'da', 'dal', 'dalla', 'in', 'nel', 'nella',
    'su', 'sul', 'sulla', 'per', 'tra', 'fra', 'con', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno',
    'una', 'che', 'e', 'o', 'ma', 'a', 'ad', 'ed', 'mi', 'mio', 'mia', 'miei', 'mie', 'quel', 'quella',
    'file', 'files', 'cartella', 'cerca', 'cercami', 'trova', 'trovami', 'apri', 'aprimi',
    'mostra', 'mostrami', 'fammi', 'vedere', 'tutti', 'tutte',
    // en
    'the', 'an', 'of', 'with', 'from', 'my', 'on', 'for', 'and', 'or', 'me', 'all',
    'find', 'search', 'show', 'open', 'get', 'that', 'this',
  ]);

  const MONTHS = new Map([
    ...['gennaio', 'january'].map((w) => [w, 0]),
    ...['febbraio', 'february'].map((w) => [w, 1]),
    ...['marzo', 'march'].map((w) => [w, 2]),
    ...['aprile', 'april'].map((w) => [w, 3]),
    ...['maggio', 'may'].map((w) => [w, 4]),
    ...['giugno', 'june'].map((w) => [w, 5]),
    ...['luglio', 'july'].map((w) => [w, 6]),
    ...['agosto', 'august'].map((w) => [w, 7]),
    ...['settembre', 'september'].map((w) => [w, 8]),
    ...['ottobre', 'october'].map((w) => [w, 9]),
    ...['novembre', 'november'].map((w) => [w, 10]),
    ...['dicembre', 'december'].map((w) => [w, 11]),
  ]);

  const UNIT_BYTES = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

  // Lowercase + strip accents so "più"/"piu" and "perché"/"perche" match the
  // same patterns. NFD splits the diacritic into a combining mark we drop.
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // Local-time day/month/year boundaries. All date math is local: "ieri" means
  // the user's yesterday, not UTC's.
  function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function startOfMonth(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); }
  function startOfYear(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setMonth(0, 1); return d.getTime(); }
  function addMonths(t, n) { const d = new Date(t); d.setMonth(d.getMonth() + n); return d.getTime(); }
  function startOfWeek(t) { // Monday, as an Italian week starts
    const d = new Date(t); d.setHours(0, 0, 0, 0);
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    d.setDate(d.getDate() - dow);
    return d.getTime();
  }
  function monthRange(year, month) {
    const from = new Date(year, month, 1).getTime();
    return { after: from, before: addMonths(from, 1) };
  }

  const DAY_MS = 86400000;

  // Each pass matches a span of the normalized string, records a chip + filter
  // and blanks the span so later passes and the term tokenizer never see it.
  function parseQuery(raw, opts) {
    const o = opts || {};
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const disable = o.disable || {};
    let s = ' ' + norm(raw).replace(/\s+/g, ' ').trim() + ' ';

    const q = { terms: [], kind: null, exts: null, after: null, before: null, minBytes: null, maxBytes: null, chips: [] };
    if (s.trim() === '') return q;

    const consume = (re, fn) => {
      s = s.replace(re, (...m) => {
        fn(m);
        return ' ';
      });
    };

    // ── Sizes ── explicit "più di 100 mb" first, then bare adjectives.
    if (!disable.size) {
      consume(/(?:piu di|more than|over|sopra(?: i| il)?|almeno|at least|>=?)\s*(\d+(?:[.,]\d+)?)\s*(kb|mb|gb|tb)\b/g, (m) => {
        q.minBytes = Math.round(parseFloat(m[1].replace(',', '.')) * UNIT_BYTES[m[2]]);
      });
      consume(/(?:meno di|less than|under|sotto(?: i| il)?|al massimo|at most|<=?)\s*(\d+(?:[.,]\d+)?)\s*(kb|mb|gb|tb)\b/g, (m) => {
        q.maxBytes = Math.round(parseFloat(m[1].replace(',', '.')) * UNIT_BYTES[m[2]]);
      });
      consume(/\b(enorm[ei]|gigant[ei]|huge)\b/g, () => { q.minBytes = UNIT_BYTES.gb; });
      consume(/\b(grand[ei]|pesant[ei]|big|large)\b/g, () => { if (q.minBytes == null) q.minBytes = 100 * UNIT_BYTES.mb; });
      consume(/\b(piccol[ei]|legger[ei]|small|tiny)\b/g, () => { q.maxBytes = UNIT_BYTES.mb; });
      if (q.minBytes != null) q.chips.push({ type: 'size', dir: 'min', bytes: q.minBytes });
      if (q.maxBytes != null) q.chips.push({ type: 'size', dir: 'max', bytes: q.maxBytes });
    }
    // When a dimension is disabled (the user removed its chip), its words are
    // NOT swallowed: removing the chip means "that interpretation was wrong",
    // so "dicembre"/"grandi" fall through and search as plain name terms.

    // ── Dates ── most specific first ("la settimana scorsa" before bare words).
    const setDate = (after, before, chip) => {
      q.after = after; q.before = before;
      q.chips.push(Object.assign({ type: 'date' }, chip));
    };
    const datePasses = [
      [/\b(?:ultim[ei]|last)\s+(\d{1,3})\s+(giorni|days)\b/, (m) => setDate(now - (+m[1]) * DAY_MS, null, { key: 'lastN', n: +m[1], unit: 'days' })],
      [/\b(?:ultim[ei]|last)\s+(\d{1,2})\s+(settimane|weeks)\b/, (m) => setDate(now - (+m[1]) * 7 * DAY_MS, null, { key: 'lastN', n: +m[1], unit: 'weeks' })],
      [/\b(?:ultim[ei]|last)\s+(\d{1,2})\s+(mesi|months)\b/, (m) => setDate(addMonths(now, -m[1]), null, { key: 'lastN', n: +m[1], unit: 'months' })],
      [/\b(?:la )?settimana scorsa\b|\blast week\b/, () => setDate(startOfWeek(now) - 7 * DAY_MS, startOfWeek(now), { key: 'lastWeek' })],
      [/\bquesta settimana\b|\bthis week\b|\bultima settimana\b/, () => setDate(startOfWeek(now), null, { key: 'thisWeek' })],
      [/\b(?:il )?mese scorso\b|\blast month\b|\bultimo mese\b/, () => setDate(addMonths(startOfMonth(now), -1), startOfMonth(now), { key: 'lastMonth' })],
      [/\bquesto mese\b|\bthis month\b/, () => setDate(startOfMonth(now), null, { key: 'thisMonth' })],
      [/\b(?:l')?anno scorso\b|\blast year\b/, () => {
        const y = new Date(now).getFullYear() - 1;
        setDate(new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime(), { key: 'lastYear' });
      }],
      [/\bquest'?anno\b|\bthis year\b/, () => setDate(startOfYear(now), null, { key: 'thisYear' })],
      [/\bieri\b|\byesterday\b/, () => setDate(startOfDay(now) - DAY_MS, startOfDay(now), { key: 'yesterday' })],
      [/\boggi\b|\btoday\b/, () => setDate(startOfDay(now), null, { key: 'today' })],
      [/\brecent[ei]?\b/, () => setDate(now - 30 * DAY_MS, null, { key: 'recent' })],
    ];
    if (!disable.date) {
      for (const [re, fn] of datePasses) {
        if (q.after != null || q.before != null) break;
        consume(new RegExp(re.source, 'g'), fn);
      }
      // Month name, optionally with a year. Without one: the most recent
      // occurrence of that month that has already started ("dicembre" asked in
      // July 2026 means December 2025).
      if (q.after == null && q.before == null) {
        consume(/\b(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|may|june|july|august|september|october|november|december)\b(?:\s+((?:19|20)\d{2})\b)?/g, (m) => {
          if (q.after != null) return; // first match wins
          const month = MONTHS.get(m[1]);
          const nowD = new Date(now);
          const year = m[2] ? +m[2] : (month <= nowD.getMonth() ? nowD.getFullYear() : nowD.getFullYear() - 1);
          const r = monthRange(year, month);
          setDate(r.after, r.before, { key: 'month', month, year });
        });
      }
      // Bare year.
      if (q.after == null && q.before == null) {
        consume(/\b((?:19|20)\d{2})\b/g, (m) => {
          if (q.after != null) return;
          const y = +m[1];
          setDate(new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime(), { key: 'year', year: y });
        });
      }
    }

    // ── Tokens ── kind words, extension words, ".ext", then leftover terms.
    const tokens = s.split(/[\s,;]+/).filter(Boolean);
    const extSet = new Set();
    for (const tok of tokens) {
      const dotExt = /^\.([a-z0-9]{1,6})$/.exec(tok);
      if (!disable.ext && dotExt) { extSet.add(dotExt[1]); continue; }
      if (!disable.ext && EXT_WORDS.has(tok)) { for (const e of EXT_WORDS.get(tok)) extSet.add(e); continue; }
      if (!disable.kind && KIND_WORDS.has(tok) && q.kind == null) { q.kind = KIND_WORDS.get(tok); continue; }
      if (STOPWORDS.has(tok)) continue;
      const clean = tok.replace(/^["'()\[\]]+|["'()\[\].,!?]+$/g, '');
      if (clean.length < 2) continue;
      if (q.terms.length < 8) q.terms.push(clean);
    }
    if (extSet.size) {
      q.exts = [...extSet];
      q.chips.push({ type: 'ext', exts: q.exts.slice() });
    }
    if (q.kind) q.chips.push({ type: 'kind', kind: q.kind });

    return q;
  }

  // The effective extension allowlist of a parsed query, or null for "any".
  // Explicit extensions narrow inside a kind when both are present.
  function effectiveExts(q) {
    if (q.exts && q.exts.length) return q.exts;
    if (q.kind && KIND_EXTS[q.kind]) return KIND_EXTS[q.kind];
    return null;
  }

  return { parseQuery, effectiveExts, KIND_EXTS };
});
