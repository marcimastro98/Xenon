// How lyrics are timed: the dots of a long pause, when the view next changes, the weight of each
// word by its syllables, when each word starts, and the pauses a line implies.
'use strict';

(() => {
  const GAP_MIN_MS = 5000;                // a blank line this long shows the pause dots
  const GAP_STEPS = 3;

  function blank(state) {
    return { state, key: '', songKey: '', songOffset: null, lines: [], plain: [], index: -1, gapStep: -1, playing: false };
  }

  // Dots for a long instrumental pause: which of GAP_STEPS has been reached, or
  // -1 when the active line is not a long blank.
  function gapStep(lines, index, ms) {
    const line = lines[index];
    const next = lines[index + 1];
    if (!line || line.text || !next) return -1;
    const len = next.t - line.t;
    if (len < GAP_MIN_MS) return -1;
    return Math.min(GAP_STEPS - 1, Math.floor((ms - line.t) / (len / GAP_STEPS)));
  }

  // When the view next needs to change: the next line, or the next pause step.
  function nextChangeAt(lines, index, ms) {
    const next = lines[index + 1];
    if (!next) return null;
    const step = gapStep(lines, index, ms);
    if (step >= 0 && step < GAP_STEPS - 1) {
      return lines[index].t + (step + 1) * ((next.t - lines[index].t) / GAP_STEPS);
    }
    return next.t;
  }

  // Sung time follows syllables, not letters ("through" is one beat, "area"
  // three), plus a short onset per word and a breath after a comma.
  const SYLLABLE_MS = 260;           // ~4 syllables a second, an average pop pace
  const WORD_ONSET = 0.25;           // in syllables
  const COMMA_BREATH = 0.6;          // in syllables
  const LINE_FILL = 0.88;            // the last word lands a little before the next line
  const STRETCH_LIMIT = 1.6;         // a slot up to this much longer than the pace is sung slower
  const VOWEL_GROUPS = /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœаеёиоуыэюяіїєαεηιουω]+/giu;
  const SYLLABIC_CHARS = /[぀-ヿ㐀-鿿가-힯]/gu;   // kana, CJK, hangul: one each

  function syllables(word) {
    const cjk = (word.match(SYLLABIC_CHARS) || []).length;
    const vowels = (word.match(VOWEL_GROUPS) || []).length;
    if (cjk || vowels) return cjk + vowels;
    const letters = (word.match(/\p{L}/gu) || []).length;
    return letters ? Math.max(1, Math.round(letters / 3)) : 0;
  }

  // When each word starts, in ms from the line's own time. `slotMs` is the time
  // until the next line (null for the last). A line followed by a long pause is
  // sung at the average pace, not stretched over the pause.
  function wordWeights(words) {
    return words.map(w => syllables(w) + WORD_ONSET + (/[,;:]$/.test(w) ? COMMA_BREATH : 0));
  }

  function wordStarts(words, slotMs) {
    const weights = wordWeights(words);
    const total = weights.reduce((a, n) => a + n, 0) || 1;
    const natural = total * SYLLABLE_MS;
    const slot = Number.isFinite(slotMs) && slotMs > 0 ? slotMs * LINE_FILL : null;
    const span = slot == null ? natural : (slot <= natural * STRETCH_LIMIT ? slot : natural);
    let acc = 0;
    return weights.map(n => { const at = (acc / total) * span; acc += n; return Math.round(at); });
  }

  // Many LRC files have no blank line before an instrumental break, so the
  // last sung line stayed lit through the whole break and the lyrics looked
  // stuck. When a line has far more time than even a slow singer needs, a
  // blank line goes where the singing has surely ended, and the view shows
  // the pause dots from there.
  const SLOW_PACE = 2;               // sung up to twice slower than the average pace
  const HOLD_TAIL_MS = 1500;         // a held last note

  function withImpliedPauses(lines) {
    const out = [];
    lines.forEach((line, i) => {
      out.push(line);
      const next = lines[i + 1];
      if (!line.text || !next) return;
      const weights = wordWeights(line.text.split(/\s+/).filter(Boolean));
      const sungMs = weights.reduce((a, n) => a + n, 0) * SYLLABLE_MS * SLOW_PACE + HOLD_TAIL_MS;
      const pauseAt = Math.round(line.t + sungMs);
      if (next.t - pauseAt >= GAP_MIN_MS) out.push({ t: pauseAt, text: '' });
    });
    return out;
  }

  window.LyricsCoreTiming = {
    GAP_MIN_MS, GAP_STEPS, blank, gapStep, nextChangeAt, wordStarts, withImpliedPauses,
  };
})();
