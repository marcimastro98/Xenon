'use strict';

// ── Fuzzy find (pure logic) ──────────────────────────────────────────────────
// The matcher behind the Settings search and the "add widget" palette search.
// Everything here works on plain strings, so it is unit-tested under Node
// (test/fuzzy-find.test.mjs) against the real i18n strings of all 11 languages.
//
// One fold for every language, applied to the query and the text alike:
//   - NFKC first: full-width forms become ASCII (Ａ１ → a1), half-width katakana
//     becomes standard katakana, Hangul compatibility jamo (what a Korean IME
//     produces mid-syllable: ㅆ) become the conjoining jamo a decomposed
//     syllable is made of — so "날ㅆ" is a real prefix of "날씨".
//   - lowercase, then NFD with the combining accents dropped (é → e, ё → е,
//     tonos → nothing), keeping й, which is its own letter in Russian and not
//     an и with an accent. Kana voicing marks are not in that range and stay.
//   - ß → ss, katakana → hiragana (テーマ and てーま are the same word), and
//     anything that is not a letter, digit or mark becomes a space.
// Korean also gets an INITIALS string (날씨 → ᄂᄊ), because typing only the
// leading consonants is how Korean users search a list.
//
// Scoring tiers follow server/search-rank.js (built for file names, so not
// reused as is): exact > whole word > prefix of the field > word start >
// substring > one typo > letters in order > two typos. Japanese and Chinese
// have no spaces between words, so a substring there counts as a word start
// rather than as a weak match. Typos are only tolerated in alphabets that
// separate words (Latin, Cyrillic, Greek) — a one-jamo or one-kanji "typo" is a
// different word.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.FuzzyFind = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  const MAX_TERMS = 8;
  const MIN_SCORE = 0.1;

  const RE_ACCENTS = /[̀-ͯ]/g;
  const RE_NOT_WORD = /[^\p{L}\p{N}\p{M}]+/gu;
  const RE_KATAKANA = /[ァ-ヶ]/g;
  const RE_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const RE_TYPO_SCRIPT = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]+$/u;
  const RE_CHOSEONG_ONLY = /^[ᄀ-ᄒ]+$/;

  function foldChunk(s) {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/й/g, 'й')
      .replace(RE_ACCENTS, '')
      .replace(/ß/g, 'ss')
      .replace(RE_KATAKANA, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  // Leading consonant of every Hangul syllable, in the conjoining block the
  // NFKC'd query uses (U+1100..U+1112).
  function initialsOf(nfkc) {
    let out = '';
    for (const ch of nfkc) {
      const cp = ch.codePointAt(0);
      if (cp >= 0xac00 && cp <= 0xd7a3) out += String.fromCharCode(0x1100 + Math.floor((cp - 0xac00) / 588));
    }
    return out;
  }

  function fold(s) {
    const nfkc = String(s == null ? '' : s).normalize('NFKC');
    return foldChunk(nfkc).replace(RE_NOT_WORD, ' ').trim();
  }

  function terms(query) {
    const f = fold(query);
    if (!f) return [];
    const out = [];
    for (const t of f.split(' ')) if (t && !out.includes(t)) out.push(t);
    return out.slice(0, MAX_TERMS);
  }

  // A prepared field: folded text, its words, and the Korean initials.
  function prepareField(text, weight, fuzzy) {
    const nfkc = String(text == null ? '' : text).normalize('NFKC');
    const f = foldChunk(nfkc).replace(RE_NOT_WORD, ' ').trim();
    return { f, words: f ? f.split(' ') : [], ini: initialsOf(nfkc), w: weight, fuzzy: !!fuzzy };
  }

  const isBoundary = (f, i) => i < 0 || i >= f.length || f[i] === ' ';

  function isSubsequence(term, f) {
    let i = 0;
    for (let j = 0; j < f.length && i < term.length; j++) if (f[j] === term[i]) i++;
    return i === term.length;
  }

  // Optimal string alignment distance (Damerau with adjacent swaps), abandoned
  // as soon as a whole row exceeds `max` — the answer is then "too far" and the
  // exact number does not matter.
  function osa(a, b, max) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    let prev2 = null;
    let prev = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      const cur = new Array(lb + 1);
      cur[0] = i;
      let rowMin = cur[0];
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[lb];
  }

  // Best typo distance between `term` and one word: the whole word, or the
  // start of a longer word (someone still typing "brighn" means "brightness").
  function wordTypo(term, word, max) {
    let best = osa(term, word, max);
    if (best <= 1 || word.length <= term.length) return best;
    for (let L = term.length - 1; L <= term.length + 1; L++) {
      if (L < 3 || L >= word.length) continue;
      best = Math.min(best, osa(term, word.slice(0, L), max));
      if (best <= 1) break;
    }
    return best;
  }

  // One term against one field, 0..1 before the field's weight. `ctx` carries
  // per-term facts and a word → typo cache shared across the whole index, so
  // the edit distance runs once per distinct word, not once per field.
  function termScore(t, field, ctx) {
    const f = field.f;
    if (!f) return 0;
    if (f === t) return 1;
    if (ctx.choseong) {
      const at = field.ini.indexOf(t);
      if (at === 0) return field.ini.length === t.length ? 0.9 : 0.6;
      if (at > 0) return 0.45;
    }
    let idx = f.indexOf(t);
    const any = idx >= 0;
    let wordStart = false;
    while (idx >= 0) {
      const left = isBoundary(f, idx - 1);
      if (left && isBoundary(f, idx + t.length)) return 0.8;
      if (left) wordStart = true;
      idx = f.indexOf(t, idx + 1);
    }
    if (any && f.startsWith(t)) return 0.7;
    if (wordStart) return 0.6;
    // One Latin letter inside a word is not a finding; at a word start it is.
    if (any) return ctx.cjk ? 0.6 : (t.length > 1 ? 0.4 : 0);
    if (!field.fuzzy) return 0;
    if (ctx.typoMax) {
      let best = ctx.typoMax + 1;
      for (const word of field.words) {
        let d = ctx.cache.get(word);
        if (d === undefined) { d = wordTypo(t, word, ctx.typoMax); ctx.cache.set(word, d); }
        if (d < best) best = d;
        if (best <= 1) break;
      }
      if (best <= 1) return 0.3;
      if (best === 2 && ctx.typoMax >= 2) return 0.15;
    }
    // Letters in order ("ntf" → notifications), but inside ONE word that starts
    // with the same letter and is not much longer: across a whole list of
    // hidden words almost any three letters appear in order somewhere.
    if (ctx.cjk) {
      if (t.length >= 2 && f.length <= 12 && isSubsequence(t, f)) return 0.2;
    } else if (t.length >= 3) {
      for (const word of field.words) {
        if (word[0] === t[0] && word.length <= t.length * 2.5 && isSubsequence(t, word)) return 0.2;
      }
    }
    return 0;
  }

  /**
   * Build a searchable index.
   * @param {Array<{fields: Array<{text:string, weight:number, fuzzy?:boolean}>}>} entries
   *   Any other properties on an entry are carried through untouched.
   */
  function createIndex(entries) {
    const items = [];
    // A card title or a category name is repeated on every row under it: fold
    // each distinct text once and share the result, weights stay per field.
    const folded = new Map();
    for (const entry of entries || []) {
      if (!entry || !Array.isArray(entry.fields)) continue;
      // The same folded text in several languages (GPU, Spotify, a brand) is
      // one field at the best weight, not eleven.
      const byText = new Map();
      for (const raw of entry.fields) {
        if (!raw || typeof raw.text !== 'string' || !raw.text) continue;
        let base = folded.get(raw.text);
        if (!base) { base = prepareField(raw.text, 0, false); folded.set(raw.text, base); }
        if (!base.f) continue;
        const w = Number(raw.weight) || 0;
        const prev = byText.get(base.f);
        if (!prev) byText.set(base.f, { f: base.f, words: base.words, ini: base.ini, w, fuzzy: !!raw.fuzzy });
        else { prev.w = Math.max(prev.w, w); prev.fuzzy = prev.fuzzy || !!raw.fuzzy; }
      }
      const fields = [...byText.values()].sort((a, b) => b.w - a.w);
      if (fields.length) items.push({ entry, fields });
    }
    return { items };
  }

  /**
   * Rank the index against a query. Every term must match somewhere.
   * @param {{items:Array}} index from createIndex
   * @param {string} query
   * @param {{limit?:number, boost?:(entry:object)=>number}} [opts]
   * @returns {Array<{entry:object, score:number}>} best first
   */
  function search(index, query, opts) {
    const ts = terms(query);
    if (!ts.length || !index || !Array.isArray(index.items)) return [];
    const o = opts || {};
    const ctxs = ts.map((t) => ({
      t,
      cjk: RE_CJK.test(t),
      choseong: RE_CHOSEONG_ONLY.test(t),
      typoMax: t.length >= 4 && RE_TYPO_SCRIPT.test(t) ? (t.length >= 8 ? 2 : 1) : 0,
      cache: new Map(),
    }));
    const out = [];
    for (const item of index.items) {
      let sum = 0;
      let firstField = null;
      let ok = true;
      for (const ctx of ctxs) {
        let best = 0;
        let bestField = null;
        for (const field of item.fields) {
          if (field.w <= best) break;   // sorted by weight: nothing below can win
          const s = termScore(ctx.t, field, ctx) * field.w;
          if (s > best) { best = s; bestField = field; }
        }
        if (!best) { ok = false; break; }
        sum += best;
        if (!firstField) firstField = bestField;
      }
      if (!ok) continue;
      let score = sum / ctxs.length;
      // Several words, written in the order a field says them.
      if (ctxs.length > 1) {
        for (const field of item.fields) {
          let at = -1;
          let inOrder = true;
          for (const ctx of ctxs) {
            const i = field.f.indexOf(ctx.t, at + 1);
            if (i < 0) { inOrder = false; break; }
            at = i;
          }
          if (inOrder) { score += 0.1 * field.w; break; }
        }
      }
      // A short field that the query nearly fills beats a long one it grazes.
      const qlen = ctxs.reduce((n, c) => n + c.t.length, 0);
      score += 0.08 * Math.min(1, qlen / firstField.f.length) * firstField.w;
      if (typeof o.boost === 'function') score += Number(o.boost(item.entry)) || 0;
      if (score >= MIN_SCORE) out.push({ entry: item.entry, score });
    }
    out.sort((a, b) => b.score - a.score);
    return o.limit ? out.slice(0, o.limit) : out;
  }

  /**
   * Where the query's words appear in `text`, as [start, end) ranges on the
   * ORIGINAL string, merged and sorted. Only real substring matches are
   * marked; a typo or a letters-in-order match highlights nothing rather than
   * something misleading.
   */
  function highlight(text, query) {
    const s = String(text == null ? '' : text);
    const ts = terms(query);
    if (!s || !ts.length) return [];
    // Fold character by character, remembering where each folded character
    // came from. One source character can fold to several (ß → ss, a Hangul
    // syllable → its jamo) or to none (a combining accent).
    let f = '';
    const map = [];
    let i = 0;
    for (const ch of s) {
      const start = i;
      i += ch.length;
      const part = foldChunk(ch.normalize('NFKC')).replace(RE_NOT_WORD, ' ');
      for (let k = 0; k < part.length; k++) { f += part[k]; map.push(start); }
    }
    const endOf = (fi) => {
      const src = map[fi];
      const cp = s.codePointAt(src);
      return src + (cp > 0xffff ? 2 : 1);
    };
    const ranges = [];
    for (const t of ts) {
      let at = f.indexOf(t);
      while (at >= 0) {
        ranges.push([map[at], endOf(at + t.length - 1)]);
        at = f.indexOf(t, at + t.length);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r.slice());
    }
    return merged;
  }

  /**
   * Append `text` to `el` with the matched parts wrapped in <mark>, built with
   * text nodes only — labels come from translations and package manifests,
   * never trusted as markup.
   */
  function renderHighlighted(el, text, query) {
    const s = String(text == null ? '' : text);
    const doc = el.ownerDocument;
    let pos = 0;
    for (const [a, b] of highlight(s, query)) {
      if (a > pos) el.appendChild(doc.createTextNode(s.slice(pos, a)));
      const mark = doc.createElement('mark');
      mark.textContent = s.slice(a, b);
      el.appendChild(mark);
      pos = b;
    }
    if (pos < s.length) el.appendChild(doc.createTextNode(s.slice(pos)));
  }

  /**
   * The fields for one translation key, in every language the dictionary has.
   * The active language counts fully, English nearly as much (the language
   * people fall back to when their own wording fails them), the rest enough to
   * be found and never enough to outrank a match in your own. Typos are only
   * forgiven in the first two: across eleven languages a one-letter slip would
   * match something unrelated.
   * @param {object} dict i18n-shaped: { it: {key: text}, en: {...}, ... }
   * @param {string} key
   * @param {number} weight
   * @param {{lang?:string, fuzzy?:boolean, mainOnly?:boolean}} [opts]
   *   mainOnly keeps only the active language and English (context fields).
   */
  function i18nFields(dict, key, weight, opts) {
    const out = [];
    if (!dict || typeof dict !== 'object' || !key) return out;
    const o = opts || {};
    const cur = o.lang || 'en';
    for (const l of Object.keys(dict)) {
      const text = dict[l] && dict[l][key];
      if (typeof text !== 'string' || !text) continue;
      const lw = l === cur ? 1 : l === 'en' ? 0.9 : 0.5;
      if (o.mainOnly && lw < 0.9) continue;
      out.push({ text, weight: weight * lw, fuzzy: !!o.fuzzy && lw >= 0.9 });
    }
    return out;
  }

  return { fold, terms, createIndex, search, highlight, renderHighlighted, i18nFields, _osa: osa };
});
