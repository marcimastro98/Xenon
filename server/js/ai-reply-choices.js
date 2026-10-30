// Answers the assistant offers with a question. It ends its reply with up to
// MAX_CHOICES lines like "[[Blue]]": the chat shows them as buttons under the
// message, one tap sends that answer. In voice the same lines are spoken as a
// plain list, so a reply never reads the brackets out. Pure, shared by the
// browser (window.AiReplyChoices) and the unit tests.
(function (root) {
  const MAX_CHOICES = 4;
  const MAX_CHOICE_CHARS = 60;
  const CHOICE_LINE = /^\s*\[\[([^\[\]\n]{1,60})\]\]\s*$/;

  // { text, choices }: the trailing choice lines come off the text. Lines in the
  // middle of a reply stay as they are, and more than MAX_CHOICES are not buttons.
  function split(text) {
    const lines = String(text || '').split('\n');
    const choices = [];
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    while (end > 0) {
      const m = CHOICE_LINE.exec(lines[end - 1]);
      if (!m) break;
      choices.unshift(m[1].trim().slice(0, MAX_CHOICE_CHARS));
      end--;
    }
    if (!choices.length || choices.length > MAX_CHOICES) return { text: String(text || ''), choices: [] };
    return { text: lines.slice(0, end).join('\n').trimEnd(), choices: choices.filter((c, i) => c && choices.indexOf(c) === i) };
  }

  // The reply as it is spoken: the choices read as one list after the question.
  function spoken(text) {
    const { text: body, choices } = split(text);
    if (!choices.length) return String(text || '').replace(/\[\[([^\[\]\n]{1,60})\]\]/g, '$1');
    return (body ? body + ' ' : '') + choices.join(', ') + '.';
  }

  const api = { split, spoken, MAX_CHOICES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AiReplyChoices = api;
})(typeof window !== 'undefined' ? window : globalThis);
