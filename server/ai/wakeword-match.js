'use strict';
// Says whether what was heard is the wake word, under the assistant's name or its old one.

// The wake phrase is "Hey Bit", the assistant's name. "Bit" alone is an everyday
// word ("a bit", "bit by bit"), so unlike the old name it only counts right after
// a call word, and whisper's accented takes of both are accepted: "ehi bit",
// "hei bit", "hey beat", "heybit".
const CALL_WORD = /^(hey|hei|hej|hay|ehi|ei|ey)$/;
const BIT_WORD = /^(bit|bitt|bits|beat|bid)$/;

// Does a transcript contain the wake phrase? Deliberately fuzzy: whisper picks
// spellings freely. "Hey Xenon", the phrase before Bit had a name, still works
// so nobody who learned it is left talking to a dashboard that no longer listens.
function matchesWakeWord(text) {
  if (typeof text !== 'string' || !text) return false;
  const plain = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const tokens = plain.split(/[^a-z]+/).filter(Boolean);
  if (tokens.some((tok, i) => CALL_WORD.test(tok) && BIT_WORD.test(tokens[i + 1] || ''))) return true;
  if (tokens.some((tok) => /^(hey|hei|ehi|ei|ey)(bit|bitt|beat)$/.test(tok))) return true;
  return matchesOldName(tokens);
}

// "Hey Xenon": the leading "hey" is optional, the old name alone is distinctive.
function matchesOldName(tokens) {
  // The product name's phonetic skeleton is consonant + vowel + n + vowel + n —
  // "xenon" / "zenon" / "senon" / "sanon" / "zenone" / "xeneon". Whisper picks the
  // vowels freely (renders "Hey Xenon" as "AXANON", "Sanon", "AXN on", …) so the
  // vowels are matched loosely and the first one may even be dropped.
  //
  // 1) The name as ONE clean token. Anchored to the whole token so multi-word
  //    Italian ("se non", "se-non-ché") and near-words ("season", "sano") — which
  //    only ever appear split or with a non-matching tail — never trigger.
  if (tokens.some(tok => /^[sxz][aeiou]*n+[aeiou]+n[aeiou]*$/.test(tok))) return true;
  // 2) Whisper also spells the name out as letters, dropping/prepending a vowel or
  //    splitting it: "AXN on" → ["axn","on"], "AXANON" → ["axanon"]. Join the
  //    letters and look for the x/z + n-cluster skeleton anywhere. Restricted to
  //    x/z (never s) so ordinary "se non…" can't false-fire once spaces are gone.
  return /[xz][aeiou]*n+[aeiou]+n/.test(tokens.join(''));
}

module.exports = { CALL_WORD, BIT_WORD, matchesWakeWord, matchesOldName };
