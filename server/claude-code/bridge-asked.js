'use strict';
// A question Claude asks, held open until a person answers: answered only with a label Claude
// offered or the person's own words, and skipped, timed out or refused is no answer.

const { URGENT_AFTER_MS, QUESTION_TTL_MS, MAX_PENDING } = require('./bridge-limits.js');
const { str, projectName } = require('./bridge-clamp.js');
const { projectQuestions, buildAnswers } = require('./bridge-questions.js');

function makeAsked({ now, sessions, pending, issued, setWait, clearWait, waitInTerminal, emit }) {
  // AskUserQuestion — a real question, answered from the touchscreen.
  //
  // The answer goes back as the tool's own input with `answers` filled in
  // (header note 2), so the tool runs and returns it exactly as it would have
  // if the user had picked it in the terminal.
  //
  // It arrives on PreToolUse rather than PermissionRequest for two reasons:
  // PreToolUse always fires, and it fires BEFORE the terminal prompt is drawn,
  // which is the only moment an outside answer can still save the user a trip.
  //
  // Nothing here can auto-answer. Running out of time resolves 'skip', which is
  // an empty hook response, which is the tool proceeding and asking in the
  // terminal exactly as it would have if Xenon were not installed.
  function askQuestion(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const projected = projectQuestions(d.tool_input);
    if (!projected) return null;                   // nothing readable to show
    if (pending.size >= MAX_PENDING) return null;
    const questions = projected.shown;

    const sessionId = str(d.session_id, 80);
    const s = sessions.get(sessionId);
    if (s) { setWait(s, 'question', questions[0] && questions[0].question); s.lastAt = now(); }

    const id = 'q' + (++issued.seq) + '-' + now().toString(36);
    const createdAt = now();
    const rec = {
      id,
      sessionId,
      kind: 'question',
      project: (s && s.project) || projectName(d.cwd),
      tool: 'AskUserQuestion',
      detail: '',
      questions,
      // Server-side only: the exact question texts (the answer keys) and the
      // input to echo back with `answers` added.
      keys: projected.keys,
      input: d.tool_input,
      plan: '',
      risks: [],
      task: (s && s.task) || '',
      model: (s && s.model) || '',
      createdAt,
      expiresAt: createdAt + QUESTION_TTL_MS,
      // Unanswered after the grace window, it takes the screen like a
      // permission does: nowhere else shows it while the hook holds it.
      urgentAt: createdAt + URGENT_AFTER_MS,
      resolve: null,
      timer: null,
    };

    const promise = new Promise((resolve) => { rec.resolve = resolve; });
    rec.timer = setTimeout(() => {
      if (pending.get(id) !== rec) return;
      pending.delete(id);
      waitInTerminal(sessions.get(rec.sessionId), rec);
      rec.resolve({ verdict: 'skip' });
      emit();
    }, QUESTION_TTL_MS);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();

    pending.set(id, rec);
    emit();
    return { id, promise };
  }

  // The user chose. `selections` is one array of labels per question, in the
  // order the card showed them, and `typed` one string per question (the
  // "Other" box, or the answer to a text/number question). Picks are matched
  // against the options Claude published rather than trusted; a typed answer is
  // the user's own words, the same thing the terminal's "Other" row sends.
  function answer(id, selections, typed) {
    const rec = pending.get(str(id, 80));
    if (!rec || rec.kind !== 'question') return false;

    const answers = buildAnswers(rec.questions, rec.keys, selections, typed);
    // Nothing recognisable chosen: refuse rather than send Claude an answer that
    // says nothing. The card stays up and the user can try again.
    if (!answers) return false;

    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    const s = sessions.get(rec.sessionId);
    clearWait(s, 'question');
    if (s) s.lastAt = now();
    rec.resolve({ verdict: 'answer', updatedInput: { ...rec.input, answers } });
    emit();
    return true;
  }

  // The user wants this one in the terminal after all. Resolves 'skip', which is
  // the same empty response the timeout gives: the tool runs and asks there.
  function skipQuestion(id) {
    const rec = pending.get(str(id, 80));
    if (!rec || rec.kind !== 'question') return false;
    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    waitInTerminal(sessions.get(rec.sessionId), rec);
    rec.resolve({ verdict: 'skip' });
    emit();
    return true;
  }

  return { askQuestion, answer, skipQuestion };
}

module.exports = { makeAsked };
