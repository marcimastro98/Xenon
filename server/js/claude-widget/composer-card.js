// The composer card: the text box with its "/" list, the attached files shown as chips (at most
// MAX_ATTACH per message), the attach and send buttons, the run's model, mode and effort, and the
// line that says where the text goes.
'use strict';

window.ClaudeWidgetComposerCard = (wrapper) => {
  const { loadAskProjects, submitAsk, addAttachments, paint, drawPicker, pickerKey } = wrapper;

  const { t } = window.ClaudeWidgetWords;
  const { widgetState, replyMode, resumeNote, inLiveSession } = window.ClaudeWidgetKnown;
  const { el } = window.ClaudeWidgetLines;
  const { composerSelect } = window.ClaudeWidgetComposerParts;
  const { askModelOptions, runModeSelect, effortSelect } = window.ClaudeWidgetRunOptions;
  const { ui } = window.ClaudeWidgetConsoleState;

  const MAX_ATTACH = 6;

  const SEND_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" '
    + 'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>';
  const CLIP_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" '
    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 11.5 11.6 20a5 5 0 0 1-7.1-7.1l8.5-8.4a3.4 3.4 0 0 1 4.8 4.8l-8.4 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg>';

  const ATTACH_ACCEPT = 'image/*,.txt,.md,.json,.csv,.log,.yml,.yaml,.xml,.html,.css,.js,.ts,.jsx,.tsx,.py,.rs,.go,.java,.c,.h,.cpp,.sql,.toml,.ini,.diff,.patch,.pdf';

  // Everything you act on lives in one card at the bottom: what you type, what
  // you attach, which model, and the button. Three separate stacked blocks read
  // as three unrelated things, and on a touchscreen the eye has to travel the
  // whole panel to find the one control it wants.

  // One line when empty, growing with the text up to the CSS max-height.
  function fitHeight(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function composer() {
    const box = el('div', 'cw-composer');
    const runLike = replyMode() === 'new' || replyMode() === 'resume';
    // The "/" list also serves a session open in a terminal, with its three commands.
    const slashOn = runLike || inLiveSession();
    if (widgetState.askProjects === null) loadAskProjects(false);

    const ta = document.createElement('textarea');
    ta.className = 'cw-ask-text';
    ta.rows = 1;
    ta.value = widgetState.askText;
    ta.placeholder = widgetState.askResumeId
      ? t('claude_ask_placeholder_more', 'Write the follow-up…')
      : t('claude_ask_placeholder', 'What should Claude do?');
    ta.title = t('claude_ask_enter_hint', 'Enter sends, Shift+Enter adds a line');
    ta.maxLength = 4000;
    ta.dataset.keep = 'ask';
    // Repainting on every keystroke would fight the caret, so the value is only
    // mirrored into state and read back when something else needs it.
    const picker = el('div', 'cw-slash');
    picker.setAttribute('role', 'listbox');
    picker.hidden = true;
    ta.addEventListener('input', () => {
      widgetState.askText = ta.value;
      fitHeight(ta);
      if (slashOn) { ui.pickAt = 0; drawPicker(picker, ta); }
    });
    // Enter sends, Shift+Enter breaks the line — the arrangement every chat box
    // has, and the one that was missing here. `isComposing` is checked because
    // an IME's Enter commits the candidate word and must not also send.
    ta.addEventListener('keydown', (e) => {
      if (slashOn && pickerKey(e, picker, ta)) { e.preventDefault(); return; }
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      widgetState.askText = ta.value;
      submitAsk();
    });
    // Paste an image straight in. On a touchscreen this is the difference
    // between "attach a screenshot" being one gesture and being a file hunt.
    ta.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.files) || null;
      if (!items || !items.length) return;
      e.preventDefault();
      widgetState.askText = ta.value;
      addAttachments(Array.from(items));
    });
    // Pasted or attached images are shown, not just named: a screenshot you
    // cannot see is one you cannot check before sending.
    if (widgetState.askAttach.length) {
      const chips = el('div', 'cw-attach-chips');
      widgetState.askAttach.forEach((a, i) => {
        const item = el('div', 'cw-attach-item' + (a.preview ? ' is-image' : ''));
        if (a.preview) {
          const img = document.createElement('img');
          img.className = 'cw-attach-img';
          img.src = a.preview;
          img.alt = a.name;
          item.appendChild(img);
        } else item.appendChild(el('span', 'cw-attach-name', a.name));
        const rm = el('button', 'cw-attach-rm'); rm.type = 'button';
        rm.setAttribute('aria-label', t('claude_attach_remove', 'Remove attachment'));
        rm.textContent = '✕';
        // The file stays on disk; it is pruned with the rest. Deleting it here
        // would mean a delete endpoint taking a path, which is exactly what this
        // design avoids.
        rm.addEventListener('click', () => {
          widgetState.askText = ta.value;
          if (a.preview) URL.revokeObjectURL(a.preview);
          widgetState.askAttach.splice(i, 1);
          paint();
        });
        item.appendChild(rm);
        chips.appendChild(item);
      });
      box.appendChild(chips);
    }

    // The attach and send buttons sit inside the text box, bottom right, so the
    // composer is one row tall when nothing else is being chosen.
    const field = el('div', 'cw-ask-field');
    field.appendChild(ta);
    const tools = el('div', 'cw-ask-tools');
    field.appendChild(tools);
    box.appendChild(field);
    box.appendChild(picker);
    requestAnimationFrame(() => fitHeight(ta));
    if (slashOn) drawPicker(picker, ta);

    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.accept = ATTACH_ACCEPT;
    input.addEventListener('change', () => { widgetState.askText = ta.value; addAttachments(Array.from(input.files || [])); });
    box.appendChild(input);

    const clip = el('button', 'cw-icon-btn'); clip.type = 'button';
    clip.disabled = widgetState.askAttachBusy || widgetState.askAttach.length >= MAX_ATTACH;
    clip.title = t('claude_attach_add', 'Attach a file');
    clip.setAttribute('aria-label', t('claude_attach_add', 'Attach a file'));
    // A drawn paperclip rather than the emoji: the emoji renders at whatever
    // size and weight the platform font decides, which is why it sat in the bar
    // looking like a smudge next to a crisp button.
    if (widgetState.askAttachBusy) clip.textContent = '…';
    else clip.innerHTML = CLIP_SVG;      // static, trusted markup
    clip.addEventListener('click', () => { widgetState.askText = ta.value; input.click(); });
    tools.appendChild(clip);

    const mode = replyMode();
    const send = el('button', 'cw-ask-send'); send.type = 'button';
    const busyLabel = mode === 'followup' ? t('claude_reply_sending', 'Queueing…')
      : mode === 'terminal' ? t('claude_terminal_sending', 'Sending…')
        : t('claude_ask_sending', 'Starting…');
    const sendLabel = widgetState.askBusy
      ? busyLabel
      : (widgetState.askResumeId ? t('claude_ask_send_more', 'Send') : t('claude_ask_send', 'Start'));
    send.title = sendLabel;
    send.setAttribute('aria-label', sendLabel);
    send.classList.toggle('is-busy', widgetState.askBusy);
    send.innerHTML = SEND_SVG;           // static, trusted markup
    send.disabled = widgetState.askBusy || mode === 'none' || (widgetState.askProjects !== null && !widgetState.askProjects.length);
    send.addEventListener('click', () => { widgetState.askText = ta.value; submitAsk(); });
    tools.appendChild(send);

    // The model sits with the composer rather than behind a settings screen:
    // picking a cheaper model for a small job is a per-run decision. It uses the
    // app's own dropdown, not a native one, so a long list stays inside the
    // display instead of falling off the bottom of the small screens.
    // Model, mode and effort apply when a run starts; a message for a live
    // session goes into that session as it is, so they are not offered there.
    if (runLike) {
      const bar = el('div', 'cw-composer-bar');
      bar.appendChild(composerSelect('cw-ask-model-sel', t('claude_ask_model', 'Model'), askModelOptions(), widgetState.askModel, (v) => { widgetState.askModel = v; }));
      if (widgetState.askOptions.modes.length) bar.appendChild(runModeSelect());
      if (widgetState.askOptions.effort) bar.appendChild(effortSelect());
      box.appendChild(bar);
    }
    // Say where the text is going BEFORE it is sent. The destinations look
    // identical from here and behave differently, and the old composer only ever
    // did one of them whatever it looked like it was doing.
    const note = mode === 'followup' ? t('claude_reply_note', 'Goes into this session when the current turn ends')
      : mode === 'terminal' ? t('claude_terminal_note', 'Shows up in the open session, as if you typed it there')
      : mode === 'resume' ? resumeNote()
        : mode === 'queued' ? t('claude_queued_note', 'A message is already waiting to be delivered')
          : mode === 'none' ? t('claude_reply_e_ended', 'That session has closed')
            : '';
    if (note) box.appendChild(el('div', 'cw-ask-note' + (mode === 'none' ? ' is-warn' : ''), note));
    if (widgetState.askError) box.appendChild(el('div', 'cw-ask-error', widgetState.askError));
    return box;
  }

  return { MAX_ATTACH, composer };
};
