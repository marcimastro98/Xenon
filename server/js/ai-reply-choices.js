// Answers the assistant offers with a question. It ends its reply with up to
// MAX_CHOICES lines like "[[Blue]]": the chat shows them as buttons under the
// message, one tap sends that answer. In voice the same lines are spoken as a
// plain list, so a reply never reads the brackets out. A line like
// "[[Blue | Calm, like the sea]]" also says what the answer means: Bit offers
// real alternatives that way, and the chat draws them as a question card
// (js/ai-ask-card.js). Pure, shared by the browser (window.AiReplyChoices) and
// the unit tests.
(function (root) {
  const MAX_CHOICES = 4;
  const MAX_CHOICE_CHARS = 60;
  const MAX_NOTE_CHARS = 100;
  const CHOICE_LINE = /^\s*\[\[([^\[\]\n]{1,170})\]\]\s*$/;
  const CHOICE_ANYWHERE = /\[\[([^\[\]\n|]{1,60})(?:\|[^\[\]\n]{0,110})?\]\]/g;

  // A model sometimes writes several on one line ("[[Yes]] [[No]]"): a line made
  // only of choices counts as many.
  const CHOICE_ROW = /^\s*(?:\[\[[^\[\]\n]{1,170}\]\]\s*){2,}$/;

  function choiceOf(line) {
    const m = CHOICE_LINE.exec(line);
    if (!m) return null;
    const [label, ...rest] = m[1].split('|');
    const answer = label.trim();
    if (answer.length > MAX_CHOICE_CHARS) return null;
    return { answer, note: rest.join('|').trim().slice(0, MAX_NOTE_CHARS) };
  }

  function choicesOf(line) {
    if (!CHOICE_ROW.test(line)) {
      const one = choiceOf(line);
      return one ? [one] : null;
    }
    const all = (line.match(/\[\[[^\[\]\n]{1,170}\]\]/g) || []).map(choiceOf);
    return all.every(Boolean) ? all : null;
  }

  // { text, choices }: the trailing choice lines come off the text, with `notes`
  // beside them when any carries one. Lines in the middle of a reply stay as they
  // are, and more than MAX_CHOICES are not buttons.
  function split(text) {
    const lines = String(text || '').split('\n');
    const found = [];
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    while (end > 0) {
      const c = choicesOf(lines[end - 1]);
      if (!c) break;
      found.unshift(...c);
      end--;
    }
    if (!found.length || found.length > MAX_CHOICES) return { text: String(text || ''), choices: [] };
    const kept = found.filter((c, i) => c.answer && found.findIndex((x) => x.answer === c.answer) === i);
    const out = { text: lines.slice(0, end).join('\n').trimEnd(), choices: kept.map((c) => c.answer) };
    if (kept.some((c) => c.note)) out.notes = kept.map((c) => c.note);
    return out;
  }

  // The reply as it is spoken: the choices read as one list after the question.
  function spoken(text) {
    const { text: body, choices } = split(text);
    if (!choices.length) return String(text || '').replace(CHOICE_ANYWHERE, (_, label) => label.trim());
    return (body ? body + ' ' : '') + choices.join(', ') + '.';
  }

  // What a key does on the question card with `count` answers: a number picks,
  // the one after them is the person's own words, a letter starts writing them.
  function keyAction(key, count) {
    if (key === 'Escape') return { leave: true };
    if (key === 'ArrowDown') return { move: 1 };
    if (key === 'ArrowUp') return { move: -1 };
    if (key.length !== 1 || key === ' ') return null;
    const n = Number(key);
    if (!Number.isInteger(n)) return { type: true };
    if (n >= 1 && n <= count) return { pick: n - 1 };
    return n === count + 1 ? { own: true } : null;
  }

  const api = { split, spoken, keyAction, MAX_CHOICES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AiReplyChoices = api;
})(typeof window !== 'undefined' ? window : globalThis);
