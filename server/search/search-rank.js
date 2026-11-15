'use strict';

// ── Local search: result ranking (pure logic) ───────────────────────────────
// Orders the results the backends return (Windows Search + the crawler index)
// by signals the system index does not use — which is where the visible win
// over the Windows search box comes from, and per FUTURE.md the main product
// risk: if this ordering is not good, nothing else matters. Keeping it a pure
// module with fixed weights makes it iterable under tests without touching
// UI or backends.
//
// Signals, in weight order:
//   name match   how well the file NAME matches the typed terms
//                (exact > prefix > word boundary > substring > subsequence)
//   recency      modified time, exponential decay
//   frequency    how often the user opened this result from Xenon
//                (usage log owned by filesearch.js, passed in as plain data)
//   affinity     results living in folders the user opens results from
//
// Pure and deterministic: no Date.now() (callers pass `now`), no I/O. Same
// UMD shape as search-query.js.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.SearchRank = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Multiplicative model: the NAME score gates, the behavioural signals
  // modulate — final = name * (BASE + SPREAD * mix). An additive model was
  // tried first and rejected by test: extreme recency could jump a whole
  // name-quality tier, putting a glued-prefix match edited today above a clean
  // word match ("contrattofusione-report" over "nuovo contratto"). With the
  // gate, other signals reorder results WITHIN comparable name quality but a
  // clearly better name always stays above a clearly worse one.
  const MIX_BASE = 0.7, MIX_SPREAD = 0.3;
  const W_RECENCY = 0.5, W_FREQ = 0.35, W_FOLDER = 0.15;
  // A content-only hit (the term is inside the document, not in its name) is
  // still a real result — Windows indexed the text — but it must never outrank
  // a name match. Floor, not zero.
  const CONTENT_HIT_NAME_SCORE = 0.15;
  const RECENCY_HALF_LIFE_DAYS = 45;
  const DAY_MS = 86400000;

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // Is `term` a subsequence of `name` ("ctrt" → "contratto")? Cheap fuzzy
  // tier for typos-by-omission; never beats a real substring match.
  function isSubsequence(term, name) {
    let i = 0;
    for (let j = 0; j < name.length && i < term.length; j++) {
      if (name[j] === term[i]) i++;
    }
    return i === term.length;
  }

  const WORD_BREAK = /[\s\-_.,()\[\]]/;
  const isBoundary = (name, i) => i < 0 || i >= name.length || WORD_BREAK.test(name[i]);

  // Match-quality tiers. A COMPLETE word (bounded on both sides, "nuovo
  // contratto" or "contratto-affitto") beats a glued prefix
  // ("contrattofusione"), which beats a bounded word start, a bare substring
  // and a subsequence, in that order.
  function termScore(term, name, nameNoExt) {
    if (name === term || nameNoExt === term) return 1;
    let idx = name.indexOf(term);
    let wordStart = false;
    while (idx >= 0) {
      const left = isBoundary(name, idx - 1);
      if (left && isBoundary(name, idx + term.length)) return 0.8;
      if (left) wordStart = true;
      idx = name.indexOf(term, idx + 1);
    }
    if (nameNoExt.startsWith(term)) return 0.6;
    if (wordStart) return 0.5;
    if (name.includes(term)) return 0.4;
    if (term.length >= 3 && isSubsequence(term, name)) return 0.2;
    return 0;
  }

  // A word of the query that only a FOLDER above the file holds ("download
  // fattura" for Download\fattura.pdf): a real match, but never as good as the
  // name itself, and never on its own (scoreName requires one name hit).
  const PATH_TERM_SCORE = 0.3;
  // One typo (two in a long word) against a whole word of the name. Below a
  // bare substring: a typo is a guess about what the user meant.
  const TYPO_SCORE = 0.25;
  // The words appear together, in the order typed ("nuovo contratto" in
  // "nuovo contratto.pdf", not "contratto nuovo"): the strongest sign it is
  // the file meant.
  const PHRASE_BONUS = 0.1;

  // Optimal string alignment distance, bounded: stops early once past `max`.
  function osa(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev2 = new Array(b.length + 1).fill(0);
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
      prev = cur;
    }
    return prev[b.length];
  }

  const WORDS = /[\s\-_.,()\[\]]+/;
  function typoScore(term, name) {
    if (term.length < 4) return 0;
    const max = term.length >= 8 ? 2 : 1;
    for (const w of name.split(WORDS)) {
      if (w.length < 3) continue;
      // A word being typed is a prefix: compare against the same length too.
      if (osa(term, w, max) <= max || (w.length > term.length && osa(term, w.slice(0, term.length), max) <= max)) return TYPO_SCORE;
    }
    return 0;
  }

  // 0..1 for how well a file name matches the query terms. Every term must
  // land somewhere: one term that matches nothing zeroes the name score (the
  // result can still survive via contentHit). No terms (filter-only query,
  // "foto di dicembre" with no leftover words) → neutral 0.5 so recency and
  // usage decide.
  //   opts.dir    the file's folder: a term missing from the name may be
  //               found in it (PATH_TERM_SCORE), as long as one term is in
  //               the name
  //   opts.typos  allow TYPO_SCORE matches (used on small candidate pools)
  function scoreName(fileName, terms, opts) {
    if (!terms || !terms.length) return 0.5;
    const o = opts || {};
    const name = norm(fileName);
    const nameNoExt = name.replace(/\.[a-z0-9]{1,6}$/, '');
    const dirParts = o.dir ? norm(o.dir).split(/[\\/]+/).filter(Boolean) : null;
    let sum = 0;
    let inName = 0;
    for (const t of terms) {
      const nt = norm(t);
      let s = termScore(nt, name, nameNoExt);
      // A typo outranks the letters-in-order tier it may also satisfy
      // ("spotfy" is both a subsequence and one typo away from "spotify").
      if (o.typos && s < TYPO_SCORE) s = Math.max(s, typoScore(nt, nameNoExt));
      if (s > 0) inName++;
      else if (dirParts && dirParts.some((part) => part.includes(nt))) s = PATH_TERM_SCORE;
      if (s === 0) return 0;
      sum += s;
    }
    if (!inName) return 0;
    let score = sum / terms.length;
    if (terms.length >= 2) {
      const phrase = terms.map(norm).join(' ');
      if (nameNoExt.replace(/[\s\-_.]+/g, ' ').includes(phrase)) score = Math.min(1, score + PHRASE_BONUS);
    }
    return score;
  }
  function recencyScore(mtime, now) {
    if (!Number.isFinite(mtime) || mtime <= 0) return 0;
    const ageDays = Math.max(0, (now - mtime) / DAY_MS);
    return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
  }

  // usage: { opens: { [pathLower]: { n, last } }, folders: { [dirLower]: n } }
  // Plain objects, bounded by their owner (filesearch.js) — this module only
  // reads them.
  function freqScore(pathLower, usage, now) {
    const rec = usage && usage.opens && usage.opens[pathLower];
    if (!rec || !rec.n) return 0;
    const base = Math.min(1, Math.log10(1 + rec.n));
    // An open from months ago should fade: same half-life as file recency.
    const decay = Number.isFinite(rec.last) ? Math.exp(-Math.max(0, (now - rec.last) / DAY_MS) / RECENCY_HALF_LIFE_DAYS) : 0.5;
    return base * (0.4 + 0.6 * decay);
  }

  function folderScore(dirLower, usage) {
    const n = usage && usage.folders && usage.folders[dirLower];
    return n ? Math.min(1, Math.log10(1 + n)) : 0;
  }

  // ── Path zones ──────────────────────────────────────────────────────────
  // Where a file LIVES is a strong prior on whether a human is looking for
  // it. Searching "xenon" must put ~\Downloads\xenon-lakeside above the
  // Recent-folder .lnk, the Prefetch trace and the WindowsApps assets that
  // happen to share the name. Three zones, MULTIPLICATIVE on the final score
  // and never a filter — a noise file with a clearly better name match still
  // surfaces, nothing is ever hidden:
  //   noise   ×0.45  OS internals and machine-generated litter
  //   program ×0.75  Program Files — app RESOURCES (dlls, manifests, styles)
  //                  are rarely what a human types a name for; the app itself
  //                  is served by the Applications tier above the file list
  //   neutral ×1     everything else
  //   user    ×1.15  the user's own folders
  const ZONE_NOISE = 0.45, ZONE_PROGRAM = 0.75, ZONE_USER = 1.15;
  // OS roots (anchored to the drive so a user folder named "windows" is safe).
  const NOISE_ROOT = /^[a-z]:\\(windows|programdata|\$recycle\.bin)(\\|$)/;
  // Machine dirs wherever they appear: store apps, package/build litter,
  // temp, caches, AppData (Recent/Start Menu .lnk noise lives there), and any
  // dot-directory (.git, .vs, .cache, .venv — the convention for tool dirs).
  const NOISE_ANYWHERE = /\\(windowsapps|node_modules|__pycache__|temp|tmp|caches?)(\\|$)|\\appdata(\\|$)|\\target\\(release|debug)(\\|$)|\\(bin|obj)\\(release|debug)(\\|$)|\\\.[a-z0-9]/;
  const USER_ZONE = /\\users\\[^\\]+\\(desktop|documents|downloads|pictures|videos|music|onedrive[^\\]*)(\\|$)/;
  const PROGRAM_FILES = /^[a-z]:\\program files( \(x86\))?(\\|$)/;

  // The same three zones on macOS and Linux, where every Windows pattern above
  // simply never matched: system roots and ~/Library/~/.cache are noise, the
  // app bundles and shared program data are program, and the user's own
  // folders (in the English and the localised names xdg-user-dirs writes) are
  // the user zone.
  const POSIX_NOISE_ROOT = /^\/(proc|sys|dev|run|tmp|var|private|system|usr\/(lib|lib64|libexec|include)|snap)(\/|$)/;
  const POSIX_NOISE_ANYWHERE = /\/(node_modules|__pycache__|caches?|library\/(caches|logs|containers|group containers|application support))(\/|$)|\/target\/(release|debug)(\/|$)|\/\.[a-z0-9]/;
  const POSIX_PROGRAM = /^\/(applications|opt|usr\/(share|bin|local))(\/|$)|\.app(\/|$)/;
  const POSIX_USER = /^\/(home|users)\/[^/]+\/(desktop|documents|downloads|pictures|movies|videos|music|scrivania|documenti|scaricati|immagini|video|musica)(\/|$)/;

  function zoneFactor(dirLower) {
    if (!dirLower) return 1;
    if (dirLower[0] === '/') {
      if (POSIX_NOISE_ROOT.test(dirLower) || POSIX_NOISE_ANYWHERE.test(dirLower)) return ZONE_NOISE;
      if (POSIX_PROGRAM.test(dirLower)) return ZONE_PROGRAM;
      if (POSIX_USER.test(dirLower)) return ZONE_USER;
      return 1;
    }
    if (NOISE_ROOT.test(dirLower) || NOISE_ANYWHERE.test(dirLower)) return ZONE_NOISE;
    if (PROGRAM_FILES.test(dirLower)) return ZONE_PROGRAM;
    if (USER_ZONE.test(dirLower)) return ZONE_USER;
    return 1;
  }

  // Rank a merged result list. Items: { path, name, dir, mtime, size,
  // contentHit? }. Returns a NEW array sorted best-first, each item annotated
  // with `score`. Items whose name matches nothing and that are not content
  // hits are dropped — they can only be noise from a backend's fuzzier match.
  function rankResults(items, terms, usage, now) {
    const t = Number.isFinite(now) ? now : Date.now();
    const scored = [];
    for (const it of items || []) {
      if (!it || typeof it.path !== 'string') continue;
      let name = scoreName(it.name || '', terms, { dir: it.dir || '', typos: it.typos === true });
      if (name === 0) {
        if (!it.contentHit) continue;
        name = CONTENT_HIT_NAME_SCORE;
      }
      const pathLower = norm(it.path);
      const dirLower = norm(it.dir || '');
      const mix =
        W_RECENCY * recencyScore(it.mtime, t) +
        W_FREQ * freqScore(pathLower, usage, t) +
        W_FOLDER * folderScore(dirLower, usage);
      const score = name * (MIX_BASE + MIX_SPREAD * mix) * zoneFactor(dirLower);
      scored.push(Object.assign({}, it, { score }));
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if ((b.mtime || 0) !== (a.mtime || 0)) return (b.mtime || 0) - (a.mtime || 0);
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return scored;
  }

  // Fold one "the user opened this result" event into a usage snapshot,
  // returning a NEW snapshot. Bounded: the oldest/least-used entries fall off
  // past the caps so the log can never grow without limit (persisted by
  // filesearch.js via writeFileAtomic).
  const MAX_OPENS = 500, MAX_FOLDERS = 200;
  function foldOpen(usage, path, dir, now) {
    const u = {
      opens: Object.assign({}, usage && usage.opens),
      folders: Object.assign({}, usage && usage.folders),
    };
    const p = norm(path), d = norm(dir || '');
    const prev = u.opens[p];
    // `p` keeps the path as spelled: the key is folded for matching, and a
    // recent file shown or re-offered must carry its real name.
    u.opens[p] = { n: (prev && prev.n || 0) + 1, last: now, p: String(path) };
    if (d) u.folders[d] = (u.folders[d] || 0) + 1;
    const openKeys = Object.keys(u.opens);
    if (openKeys.length > MAX_OPENS) {
      openKeys.sort((a, b) => (u.opens[a].last || 0) - (u.opens[b].last || 0));
      for (const k of openKeys.slice(0, openKeys.length - MAX_OPENS)) delete u.opens[k];
    }
    const folderKeys = Object.keys(u.folders);
    if (folderKeys.length > MAX_FOLDERS) {
      folderKeys.sort((a, b) => u.folders[a] - u.folders[b]);
      for (const k of folderKeys.slice(0, folderKeys.length - MAX_FOLDERS)) delete u.folders[k];
    }
    return u;
  }

  return { scoreName, rankResults, foldOpen, recencyScore, freqScore, zoneFactor, norm, _osa: osa };
});
