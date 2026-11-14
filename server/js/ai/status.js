// Shows what the AI is doing: the status line and the steps of a working turn.
'use strict';

function setAiStatus(state, detail) {
  const el = $('ai-status');
  if (!el) return;
  el.className = 'ai-status' + (state ? ` ai-status-${state}` : '');
  if (window.BitChat) BitChat.setStatus(state);
  if (state === 'thinking') {
    el.innerHTML = '<span class="ai-thinking-dots"><span></span><span></span><span></span></span>';
  } else if (state === 'working' && window.AiTurnWait) {
    _aiRenderWorking(el, window.AiTurnWait.describe(detail));
  } else if (state === 'connecting') {
    el.textContent = t('ai_connecting');
  } else if (state === 'listening') {
    el.textContent = t('ai_listening');
  } else {
    el.textContent = '';
  }
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies(); // keep copy status in sync
}

// The wait on a long turn: the steps the turn went through, each ticked off
// when the next begins, the current one with the time spent, and past a while
// a line saying the chat can be closed. Built once and updated in place.
const AI_STEP_TICK = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5 5.6 10.5 11.5 3.8"/></svg>';
const AI_STEP_SPIN = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle class="ai-step-track" cx="7" cy="7" r="5.2"/><path class="ai-step-arc" d="M7 1.8a5.2 5.2 0 0 1 5.2 5.2"/></svg>';

function _aiRenderWorking(el, info) {
  let row = el.querySelector('.ai-wait');
  if (!row) {
    el.textContent = '';
    row = document.createElement('div');
    row.className = 'ai-wait';
    const steps = document.createElement('ol');
    steps.className = 'ai-steps';
    const hint = document.createElement('div');
    hint.className = 'ai-wait-hint';
    hint.hidden = true;
    row.append(steps, hint);
    el.appendChild(row);
  }
  const steps = row.querySelector('.ai-steps');
  let current = steps.lastElementChild;
  if (!current || current.querySelector('.ai-step-label').textContent !== info.text) {
    if (current) {
      current.classList.replace('is-current', 'is-done');
      current.querySelector('.ai-step-icon').innerHTML = AI_STEP_TICK;
      current.querySelector('.ai-step-time').remove();
    }
    current = document.createElement('li');
    current.className = 'ai-step is-current';
    const icon = document.createElement('span');
    icon.className = 'ai-step-icon';
    icon.innerHTML = AI_STEP_SPIN;
    const label = document.createElement('span');
    label.className = 'ai-step-label';
    label.textContent = info.text;
    const time = document.createElement('span');
    time.className = 'ai-step-time';
    current.append(icon, label, time);
    steps.appendChild(current);
  }
  current.querySelector('.ai-step-time').textContent = info.time;
  const hint = row.querySelector('.ai-wait-hint');
  hint.hidden = !info.long;
  if (info.long) hint.textContent = t('ai_wait_long');
}
