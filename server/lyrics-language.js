'use strict';

// ── Lyrics: "this is surely already in your language" ────────────────────────
// Pure helper, no I/O. Translating a song costs one request on the user's own AI
// provider, and the language of the song is only known once that request has been
// made. For a song that is already in the dashboard language that request is
// wasted, so this answers it locally, for free, but ONLY when it is certain:
// every doubt returns false and the song goes to the model exactly as before.
// A false here costs one request (what happens today); a wrong true would hide a
// translation the user needed, so each rule below leans towards false.
//
// The evidence is function words: the short, very frequent words of a language.
// Each list holds only words that belong to ONE language of the set (a test keeps
// them disjoint), so "con", "no", "me" or "de", shared by several, are left out.

const WORDS = Object.freeze({
  it: 'gli che non sono è ma perché anche della dello nel nella nei nelle negli dei delle uno mi ti ci vi questo questa quando più già ancora sempre tutto tutti niente cosa io lui lei noi voi loro sul sulla alla allo dal dai dalla di ho hai ha abbiamo voglio essere fare dove senza dentro fuori ogni poi così oggi sei siamo siete però quello quella nostro vostro'.split(' '),
  en: "the and you your that this with have are was were will would could what when where just don't i'm it's can't we they them been from about there their but all she he my our out now know got gonna wanna into than then".split(' '),
  es: 'el los las que qué por para pero como cómo porque está estoy eres soy tengo tiene hay muy más ya yo tú usted nosotros mis tus sus su del esto esta este ese esa cuando donde dónde nada siempre sin sobre también aquí así hoy quiero puedo ella ellos'.split(' '),
  pt: 'você vocês não são estou uma mas também então muito meu minha seu sua nós eles elas ela isso isto aqui agora ainda tudo coração estar tenho tem vou foi dos das pelo pela num numa ao aos com mim comigo pra'.split(' '),
  fr: "le les une est et pas qui dans pour avec sur elle nous vous ils elles mon mes ton ta ses cette ce ces où comme très tout tous toujours jamais encore aussi être suis ai c'est j'ai n'est qu'il d'un".split(' '),
  de: 'der die und ich du ist nicht ein eine mit für auf wir ihr er mein dein mich dich mir dir wie wenn aber auch noch nur schon immer kein bin bist sind wird hab habe dass uns euch diese dieser nichts heute doch denn weil oder von den dem sich nein herz'.split(' '),
  nl: 'het een ik jij je hij zij wij jullie niet geen maar dat dit wat voor naar ook nog wel zijn ben bent heb hebt heeft mijn jouw onze deze als dan toch altijd nooit niets daar waar omdat mij jou ons hun gaat komt wil kan'.split(' '),
  ru: 'и в не на я что он это как мы ты она они мне меня тебя тебе мой моя все всё так но для или если когда уже еще ещё только быть нет без там тут где чтобы потому очень'.split(' '),
});

// Languages the dashboard does not translate to, but whose songs share many words
// with one that it does: Catalan and Galician with Spanish or Portuguese, the
// Scandinavian languages with German, Afrikaans with Dutch. A few of their own
// function words in a song are enough to say "not sure". Words already owned by
// a target language above are dropped, so the lists stay disjoint from WORDS.
const NEIGHBOURS = Object.freeze({
  ca: 'amb els perquè això aquest aquesta aquests dels pels sóc ets som estic vull res avui nit molt ens jo però'.split(' '),
  gl: 'unha moito tamén xa aínda ollos teño estou'.split(' '),
  nordic: 'jeg ikke og har til meg deg mig dig hvad hva hvor aldri aldrig alltid altid også når kun være skal ingen noe noget jag inte och är att mitt vad varför kärlek bara'.split(' '),
  af: 'ek jy nie sal hulle baie julle vir hierdie maar'.split(' '),
});
const NEIGHBOUR_HITS = 4;       // this many words of a near language: not sure

const LATIN_TARGETS = ['it', 'en', 'es', 'pt', 'fr', 'de', 'nl'];

const MIN_LINES = 8;            // fewer distinct lines say too little
const MIN_WORDS = 40;
const MIN_SCRIPT_SHARE = 0.98;  // letters in the expected alphabet
const WORDY_LINE = 3;           // a line with this many words counts as evidence
const MIN_TARGET_LINES = 0.5;   // share of wordy lines holding a word of the target
const FOREIGN_LINE_HITS = 2;    // another language this strong on one line: not sure
const MIN_SCORE = 10;
const DOMINANCE = 3;            // target score over the runner-up's

const OWNER = new Map();
Object.keys(WORDS).forEach(l => WORDS[l].forEach(w => OWNER.set(w, l)));

const NEAR = new Map();
Object.keys(NEIGHBOURS).forEach(l => NEIGHBOURS[l].forEach(w => { if (!OWNER.has(w)) NEAR.set(w, l); }));

const UKRAINIAN_RE = /[іїєґ]/;

// Lowercase words of a line; a word with an apostrophe is kept whole ("don't",
// "c'est") and, when the part before it is a short elision ("l'", "dell'", "j'"),
// also as the word after it.
function words(line) {
  const out = [];
  const found = String(line || '').toLowerCase().replace(/[‘’`´]/g, "'").match(/\p{L}[\p{L}\p{M}']*/gu) || [];
  for (const raw of found) {
    const w = raw.replace(/'+$/, '');
    if (!w) continue;
    out.push(w);
    const cut = w.indexOf("'");
    if (cut > 0 && cut <= 4 && cut < w.length - 1) out.push(w.slice(cut + 1));
  }
  return out;
}

function scriptShare(text, re) {
  const letters = text.match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  return letters.filter(ch => re.test(ch)).length / letters.length;
}

// `unique` are the distinct non-empty lines of the song (lyrics-translate.js
// uniqueLines). True only when `lang` is surely the language they are sung in.
function isSurelyLang(unique, lang) {
  if (!Array.isArray(unique) || unique.length < MIN_LINES) return false;
  const cyrillic = lang === 'ru';
  if (!cyrillic && !LATIN_TARGETS.includes(lang)) return false;
  const text = unique.join('\n');
  if (cyrillic && UKRAINIAN_RE.test(text.toLowerCase())) return false;
  if (scriptShare(text, cyrillic ? /\p{Script=Cyrillic}/u : /\p{Script=Latin}/u) < MIN_SCRIPT_SHARE) return false;

  const score = {};
  let total = 0;
  let wordy = 0;
  let withTarget = 0;
  const near = {};
  for (const line of unique) {
    const ws = words(line);
    total += ws.length;
    for (const w of ws) {
      const l = NEAR.get(w);
      if (l && (near[l] = (near[l] || 0) + 1) >= NEIGHBOUR_HITS) return false;
    }
    const hits = {};
    for (const w of ws) {
      const owner = OWNER.get(w);
      if (owner) { hits[owner] = (hits[owner] || 0) + 1; score[owner] = (score[owner] || 0) + 1; }
    }
    const mine = hits[lang] || 0;
    // One line that is clearly another language (a chorus in English inside an
    // Italian song) and the model decides, as it always did.
    for (const other of Object.keys(hits)) {
      if (other !== lang && hits[other] >= FOREIGN_LINE_HITS && hits[other] > mine) return false;
    }
    if (ws.length >= WORDY_LINE) { wordy += 1; if (mine > 0) withTarget += 1; }
  }
  if (total < MIN_WORDS || !wordy || withTarget / wordy < MIN_TARGET_LINES) return false;
  const mine = score[lang] || 0;
  const runnerUp = Math.max(0, ...Object.keys(score).filter(l => l !== lang).map(l => score[l]));
  return mine >= MIN_SCORE && mine >= DOMINANCE * runnerUp;
}

// The language a song is surely in when it is NOT `lang`, or '' (no certainty).
// It checks what an AI provider says: a small model sometimes names the
// dashboard language as the song's, and "already in your language" would then
// hide a translation the user needed.
function surelyOtherLang(unique, lang) {
  return [...LATIN_TARGETS, 'ru'].find(other => other !== lang && isSurelyLang(unique, other)) || '';
}

module.exports = { isSurelyLang, surelyOtherLang, WORDS, words };
