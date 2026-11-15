// What a decision of the Claude tile says: who asks and for what, what the request would reach, and
// the foot with the time left.
'use strict';

window.ClaudeWidgetDecisionSheet = (wrapper) => {
  const { AK, approvals, questionKeys } = wrapper;

  const { t, toolIntent, RISK_LABEL, askedBy, sheetTitle } = window.ClaudeWidgetWords;
  const { sessionById, titles } = window.ClaudeWidgetKnown;
  const { el, timerOf } = window.ClaudeWidgetLines;
  const { markdownInto } = window.ClaudeWidgetMarkdown;

  // Still, and in the session's own colour: the same one the rail gives it.
  function sheetHead(a) {
    const who = window.ClaudeIdent.describe(sessionById(a.sessionId) || { id: a.sessionId, project: a.project }, titles());
    const mark = el('span', 'cw-clawd is-s' + who.slot);
    mark.appendChild(window.ClaudeClawd.make('cw-clawd-svg'));
    return AK.sheetHead({ mark, title: sheetTitle(a), line: askedBy(a) });
  }

  function sheetFoot(a, keys) {
    const others = approvals().filter((x) => x.urgent).length - 1;
    return AK.sheetFoot({
      timer: timerOf(a),
      after: t('claude_dec_expires', 'After this the terminal asks instead'),
      more: others > 0 ? t('claude_more_waiting', '{n} more waiting').replace('{n}', String(others)) : '',
      keys,
    });
  }

  function planText(plan) {
    const box = el('div', 'cw-dec-plan');
    markdownInto(box, plan);
    return box;
  }

  function decisionBody(a, big, risks, onInput) {
    const body = el('div', 'cw-dec-body');
    if (a.kind === 'question') {
      body.appendChild(questionKeys(a, onInput, big));
      return body;
    }
    const isPlan = a.kind === 'plan';
    if (!big) body.appendChild(el('div', 'cw-dec-what', isPlan ? t('claude_xp_what', 'Ready to code?') : toolIntent(a.tool)));
    if (a.plan) body.appendChild(planText(a.plan));
    else if (a.detail && !isPlan) body.appendChild(el('div', 'cw-dec-cmd', a.detail));
    if (risks.length && !isPlan) {
      const line = el('div', 'cw-dec-risks');
      risks.forEach((r) => { if (RISK_LABEL[r]) line.appendChild(el('span', 'cw-risk is-' + r, RISK_LABEL[r]())); });
      body.appendChild(line);
    }
    return body;
  }

  return { sheetHead, sheetFoot, decisionBody };
};
