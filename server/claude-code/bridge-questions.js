'use strict';
// A question or a plan Claude Code asks about: the card the tile draws for it, and the answer
// handed back to the session in the tool's own shape.

const {
  MAX_INPUT_CHARS, MAX_FOLLOWUP_CHARS, MAX_QUESTIONS, MAX_OPTIONS, MAX_TYPED, QUESTION_KINDS,
} = require('./bridge-limits.js');
const { str, num } = require('./bridge-clamp.js');

// AskUserQuestion carries the question and its options in the tool input. The
// generic describeTool() saw only an array and produced nothing, so the card
// said "AskUserQuestion" and offered Allow/Deny over a question the user could
// not read. Project the questions so the card can show what is being asked.
//
// These are answerable from the tile: see askQuestion, and note 2 in the header
// for how. `keys` is the question text EXACTLY as Claude wrote it, unclamped:
// it is the key of the `answers` map the tool reads, so the shortened copy the
// card shows cannot stand in for it. It stays on the server.
function projectQuestions(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : null;
  if (!qs || !qs.length) return null;
  const shown = [];
  const keys = [];
  for (const q of qs.slice(0, MAX_QUESTIONS)) {
    if (!q || typeof q !== 'object' || typeof q.question !== 'string' || !q.question.trim()) continue;
    const opts = Array.isArray(q.options) ? q.options : [];
    const kind = QUESTION_KINDS.has(q.kind) ? q.kind : 'choice';
    const p = {
      question: str(q.question, MAX_INPUT_CHARS),
      header: str(q.header, 40),
      kind,
      multiSelect: kind === 'choice' && q.multiSelect === true,
      options: kind !== 'choice' ? [] : opts.slice(0, MAX_OPTIONS).map((o) => ({
        label: str(o && o.label, 120),
        description: str(o && o.description, 240),
      })).filter((o) => o.label),
    };
    if (kind === 'text') p.placeholder = str(q.placeholder, 120);
    if (kind === 'number') {
      p.min = num(q.min); p.max = num(q.max); p.step = num(q.step); p.unit = str(q.unit, 20);
    }
    shown.push(p);
    keys.push(q.question);
  }
  return shown.length ? { shown, keys } : null;
}
function describeQuestions(input) {
  const p = projectQuestions(input);
  return p ? p.shown : null;
}

// One answer for a multi-select question, in the form AskUserQuestion itself
// uses: labels joined with ", ", and a label that contains ", " or a quote
// JSON-quoted so the join stays reversible (Claude Code's own joiner does the
// same, which is what lets it split the string back into picks).
function joinAnswer(labels) {
  return labels.map((l) => (l.includes(', ') || l.includes('"') ? JSON.stringify(l) : l)).join(', ');
}

// A typed answer: trimmed, bounded, and with control characters removed so
// a stray paste cannot put a terminal escape into someone's session.
function typedAnswer(v) {
  if (typeof v !== 'string') return '';
  return str(v.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''), MAX_TYPED);
}

// The `answers` map AskUserQuestion reads: { question text → answer }. Picks are
// matched against the options Claude published, and a typed answer is the
// tile's "Other" box — the same free text the terminal's "Other" row accepts.
// Returns null when nothing was answered, so the card stays up.
function buildAnswers(questions, keys, selections, typed) {
  const answers = {};
  let any = false;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const text = typedAnswer(Array.isArray(typed) ? typed[i] : '');
    let value = '';
    if (q.kind === 'number') {
      const n = Number(text);
      const inRange = text !== '' && Number.isFinite(n)
        && (q.min === null || q.min === undefined || n >= q.min)
        && (q.max === null || q.max === undefined || n <= q.max);
      value = inRange ? String(n) : '';
    } else if (q.kind === 'text') {
      value = text;
    } else {
      const allowed = new Set(q.options.map((o) => o.label));
      const raw = Array.isArray(selections) && Array.isArray(selections[i]) ? selections[i] : [];
      const picks = [];
      for (const label of raw) {
        const l = str(label, 120);
        if (l && allowed.has(l) && picks.indexOf(l) === -1) picks.push(l);
        if (picks.length >= MAX_OPTIONS) break;
      }
      if (q.multiSelect) value = joinAnswer(text ? picks.concat(text) : picks);
      else value = text || picks[0] || '';
    }
    if (value) { answers[keys[i]] = value; any = true; }
  }
  return any ? answers : null;
}

// What Claude reads when the user sends a plan back from the tile. Claude Code's
// own "No, keep planning" row carries the typed feedback the same way: as the
// reason the tool call was declined, with Claude still in plan mode.
function planFeedbackMessage(feedback) {
  const f = typedAnswer(feedback);
  if (f) {
    return 'The user reviewed the plan on the Xenon dashboard and wants changes before you start. '
      + 'Stay in plan mode, revise the plan with this feedback, and present it again:\n\n' + f;
  }
  return 'The user reviewed the plan on the Xenon dashboard and did not approve it. '
    + 'Stay in plan mode and ask what they would like to change.';
}

// The text handed to Claude when a follow-up typed on the dashboard is delivered
// at the end of a turn (header note 3). It is framed as what it is — the user
// speaking, a moment late — because an unlabelled instruction arriving out of
// nowhere reads like an injection attempt, and is correctly treated as one.
function followUpReason(text) {
  const t = str(text, MAX_FOLLOWUP_CHARS);
  if (!t) return '';
  return 'The user sent this from the Xenon dashboard while you were finishing. '
    + 'It is a follow-up in this same conversation, from the same person:\n\n'
    + t;
}

module.exports = {
  projectQuestions, describeQuestions, joinAnswer, typedAnswer, buildAnswers, planFeedbackMessage,
  followUpReason,
};
