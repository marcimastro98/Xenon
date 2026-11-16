'use strict';
// Claude Code widget: an instrument for the sessions running on this PC.
//
//   DECISIONS first, on both faces: a permission Claude Code is blocked on, or a
//     question it asked, with what the request would reach (publishes, network,
//     outside the project, cannot be undone) said before the keys. An
//     irreversible one is allowed by holding the key, not tapping it. One left
//     unanswered escalates to a fullscreen overlay.
//   LIVE face: one lane per session (state, the step it is on, ten minutes of
//     activity, its own plan, context used) beside the real 5-hour and 7-day
//     windows, each with an even-pace marker and a sentence saying where this
//     pace ends. Without the link it falls back to the user-set weekly budget.
//   USAGE face: one 30-day window, said as such, read from the transcripts:
//     today, since Monday, the total, the cache share, the value at list
//     prices, thirty days of columns, projects and models.
//   CHATS face (js/claude-code/claude-history.js): every chat kept on this PC, with its
//     size, and a confirmed move of the chosen ones to the Recycle Bin.
//
// Every string here is filesystem- or Claude-derived and renders through
// textContent / the el() factory — never innerHTML.
(function () {
  const { el, ageNode, tileHead, nowLine, toolsRow } = window.ClaudeWidgetLines;
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const AK = window.ApprovalKeys;
  const {
    t, hTok, dur, ago, fmtMoney, endedLabel, toolIntent, askedBy, stateLabel, attachErrorText,
    replyErrorText, runErrorText,
  } = window.ClaudeWidgetWords;

  const {
    widgetState, live, limits, sessions, COLLAPSE_KEY, readCollapsed, isCollapsed, runs,
    resolveAskProject, sessionById, clearAttach, promptWithAttachments, replyMode, askSession,
    inLiveSession, titles, runsFor, currentPlanKey, stopTicker,
  } = window.ClaudeWidgetKnown;
  const seedState = {
    seeded: false,
    seedInflight: false,
  };
  const { deciding, qsel, typedAns, OTHER, typedFor, answerReady } = window.ClaudeWidgetDecisionKeys;
  // The one line that installs the Claude Code mod (integrations/claude-code/).

  const {
    tiles, isParked, approvalsOn, approvals, forgetSeen, decisionsFor,
  } = window.ClaudeWidgetDecisionsShown;

  // ── model → hue. Encodes which model produced the work, not decoration. ──
  const { modelHue, shortModel, prettyModel } = window.ClaudeWidgetModelWords;

  // ── formatting ──

  // ── what this widget is allowed to put in front of you ─────────────────────

  // ── formatting in the reader's language ────────────────────────────────────

  // ── ages that tick ─────────────────────────────────────────────────────────
  // Every age on this tile ("waiting 0:42", "running 3m") used to be frozen at
  // the moment the server built the payload: a session showed "0s" until the
  // next change. The server sends how old things were WHEN IT SENT them; this
  // side adds the time since it arrived. That is right on a paired phone whose
  // clock disagrees with the PC's, where comparing two clocks would not be.
  widgetState.payloadAt = Date.now();

  const { quotaPanel, usageFace } = window.ClaudeWidgetFigures({ openBudget });

  // ── approvals ──────────────────────────────────────────────────────────────
  // `extra` is only for a plan card: the mode its row approves into, or the
  // feedback it is sent back with.
  async function decide(id, behavior, extra) {
    if (deciding.has(id)) return;
    deciding.add(id);
    paint();
    const d = await api('/api/claude/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, behavior, ...(extra || {}) }),
    });
    deciding.delete(id);
    typedAns.delete(id);
    if (!d || !d.ok) {
      // Expired, or answered on another surface. Say so — a silent no-op here
      // reads as a broken button.
      if (window.XenonToast) window.XenonToast.show({ type: 'warn', title: t('claude_decide_late', 'That request is no longer waiting') });
    }
    // The SSE push repaints with the request gone; drop it locally meanwhile so
    // the card can't be tapped twice.
    const l = live();
    if (l && l.approvals) l.approvals = l.approvals.filter(a => a.id !== id);
    paint();
  }

  // ── answering a question ───────────────────────────────────────────────────

  function pickOption(a, qi, label, multi) {
    const cur = qsel.get(a.id) || a.questions.map(() => []);
    const row = cur[qi] || [];
    if (multi) {
      const at = row.indexOf(label);
      cur[qi] = at === -1 ? row.concat(label) : row.filter((x) => x !== label);
    } else {
      cur[qi] = row.length === 1 && row[0] === label ? [] : [label];
    }
    qsel.set(a.id, cur);
    paint();
  }

  async function sendAnswer(a, skip) {
    if (deciding.has(a.id)) return;
    deciding.add(a.id);
    paint();
    const cur = qsel.get(a.id) || [];
    const typed = typedAns.get(a.id) || [];
    // A typed answer counts only where it is the answer: its question is a
    // text/number one, or "Other" is picked. Text left in a box the user then
    // closed is not something they chose to send.
    const body = skip ? { id: a.id, skip: true } : {
      id: a.id,
      selections: (a.questions || []).map((q, qi) => (cur[qi] || []).filter((l) => l !== OTHER)),
      typed: (a.questions || []).map((q, qi) => (
        q.kind === 'text' || q.kind === 'number' || (cur[qi] || []).indexOf(OTHER) !== -1 ? String(typed[qi] || '') : '')),
    };
    const d = await api('/api/claude/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    deciding.delete(a.id);
    qsel.delete(a.id);
    typedAns.delete(a.id);
    if (!d || !d.ok) {
      // Claude stopped waiting, or it was answered in the terminal. Saying so
      // beats a button that appears to do nothing.
      if (window.XenonToast) window.XenonToast.show({ type: 'warn', title: t('claude_decide_late', 'That request is no longer waiting') });
    }
    const l = live();
    if (l && l.approvals) l.approvals = l.approvals.filter((x) => x.id !== a.id);
    paint();
  }

  // ── a follow-up into a live session ────────────────────────────────────────
  // Offered while a turn is running (delivered when it ends), or while the
  // session is idle with the Xenon mod listening in it (the mod starts a turn
  // with it there). Any other idle session takes the resume path instead
  // (submitAsk), and the composer says which is about to happen before you
  // press send.
  async function queueReply(sessionId, text) {
    const d = await api('/api/claude/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    });
    return d && d.ok ? { ok: true, via: d.via || 'turn' } : { ok: false, error: (d && d.error) || 'failed' };
  }
  async function cancelReply(sessionId) {
    await api('/api/claude/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cancel: true }),
    });
    const s = sessions().find((x) => x.id === sessionId);
    if (s) s.queued = null;
    paint();
  }


  // ── the decision card ──────────────────────────────────────────────────────
  const {
    isArmed, key, holdKey, questionKeys, planKeys,
  } = window.ClaudeWidgetCardKeys({ AK, paint, decide, pickOption });

  const {
    sheetHead, sheetFoot, decisionBody,
  } = window.ClaudeWidgetDecisionSheet({ AK, approvals, questionKeys });

  function decisionCard(a, big) {
    const isAsk = a.kind === 'question';
    const isPlan = a.kind === 'plan';
    const risks = Array.isArray(a.risks) ? a.risks : [];
    const irreversible = risks.indexOf('irreversible') !== -1;
    const armed = isArmed(a);
    const card = el('section', 'cw-dec is-' + (isAsk ? 'question' : isPlan ? 'plan' : 'permission')
      + (big ? ' is-big ask-sheet' : '') + (irreversible ? ' is-risky' : '') + (armed ? '' : ' is-arming'));
    card.setAttribute('aria-live', 'polite');
    card.appendChild(big ? sheetHead(a) : tileHead(a));

    // Typing never repaints, so the Answer key's enabled state is updated here.
    let send = null;
    const refreshSend = () => { if (send) send.disabled = deciding.has(a.id) || !answerReady(a); };
    card.appendChild(decisionBody(a, big, risks, refreshSend));

    if (isPlan) {
      card.appendChild(planKeys(a));
      if (big) card.appendChild(sheetFoot(a));
      return card;
    }
    const acts = el('div', 'cw-dec-acts');
    if (isAsk) {
      acts.appendChild(key('is-quiet', t('claude_q_terminal', 'In the terminal'), () => sendAnswer(a, true), a));
      send = key('is-allow', t('claude_q_send', 'Answer'), () => sendAnswer(a, false), a);
      refreshSend();
      acts.appendChild(send);
    } else {
      acts.appendChild(key('is-deny', t('claude_deny', 'Deny'), () => decide(a.id, 'deny'), a));
      acts.appendChild(irreversible ? holdKey(a) : key('is-allow', t('claude_allow', 'Allow'), () => decide(a.id, 'allow'), a));
    }
    card.appendChild(big ? sheetFoot(a, acts) : acts);
    return card;
  }

  // Esc is the answer that starts nothing, as it is in the terminal: a request is
  // refused, a question goes back to the terminal, a plan stays a plan.
  function answerNothing(a) {
    if (deciding.has(a.id) || !isArmed(a)) return;
    if (a.kind === 'question') sendAnswer(a, true);
    else if (a.kind === 'plan') decide(a.id, 'deny', { feedback: String(typedFor(a)[0] || '') });
    else decide(a.id, 'deny');
  }

  // The escalation: an urgent request takes the whole display. Rendered outside
  // the tile so it works even when the widget isn't on the current page.
  function syncOverlay() {
    if (widgetState.pressing) { widgetState.renderDeferred = true; return; }
    const urgent = approvals().filter(a => a.urgent)[0];
    if (!urgent) { sheet.close(); return; }
    sheet.paint(decisionCard(urgent, true), { label: askedBy(urgent), esc: () => answerNothing(urgent) });
  }

  // ── live sessions ──────────────────────────────────────────────────────────
  const {
    ctxGauge, queuedRow, decisionStack, othersBar, runCard,
  } = window.ClaudeWidgetSessionParts({ cancelReply, decisionCard, select, runChips, consoleHelpers, stopRun });

  // A message the open session did not take comes back into the box, once per
  // failure, with the reason. A draft typed since then is never overwritten.
  const restored = new Set();
  function restoreUndelivered(s) {
    const u = s && s.undelivered;
    if (!u || s.id !== widgetState.askResumeId) return;
    const key = s.id + ':' + u.at;
    if (restored.has(key)) return;
    restored.add(key);
    if (restored.size > 20) restored.delete(restored.values().next().value);
    if (!widgetState.askText.trim()) widgetState.askText = u.text;
    widgetState.askError = u.reason === 'dropped' ? t('claude_terminal_e_dropped', 'Claude Code did not take the message. The session shows why.')
      : u.reason === 'closed' ? t('claude_terminal_e_closed', 'The session was closed before the message got there.')
        : t('claude_terminal_e_refused', 'The message could not reach the open session.');
  }

  // ── sections that fold ─────────────────────────────────────────────────────

  function toggleCollapsed(key) {
    const c = readCollapsed();
    c[key] = !c[key];
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(c)); } catch { /* private mode: session-only */ }
    paint();
  }

  const {
    collapsibleTitle, asideHide, quotaMini,
  } = window.ClaudeWidgetSmallControls({ toggleCollapsed, setFace });

  // ── link panel ─────────────────────────────────────────────────────────────
  // Connecting writes hooks + a statusline into the user's Claude Code
  // settings.json. That is someone else's config file, so the panel says exactly
  // what happens, and disconnecting is one tap away.
  async function loadLinkState() {
    const d = await api('/api/claude/link');
    if (d) widgetState.linkState = d;
    paint();
  }
  async function doLink(on) {
    if (widgetState.linking) return;
    widgetState.linking = true; paint();
    const d = await api(on ? '/api/claude/link' : '/api/claude/unlink', { method: 'POST' });
    widgetState.linking = false;
    if (d && d.ok) {
      widgetState.linkState = d;
      widgetState.linkPanel = false;
      if (window.XenonToast) {
        window.XenonToast.show({
          type: 'ok',
          title: on ? t('claude_linked', 'Claude Code connected') : t('claude_unlinked', 'Claude Code disconnected'),
          body: on ? t('claude_linked_body', 'Restart any running Claude Code session to pick it up.') : '',
        });
      }
    } else if (window.XenonToast) {
      window.XenonToast.show({ type: 'error', title: t('claude_link_fail', 'Could not update Claude Code settings') });
    }
    paint();
  }

  const { linkButton, linkPanelView } = window.ClaudeWidgetLinkPanel({ paint, doLink });

  const { markdownInto } = window.ClaudeWidgetMarkdown;

  const { budgetEditor } = window.ClaudeWidgetBudgetEditor({ closeBudget, postBudget, paint });

  const { composerSelect } = window.ClaudeWidgetComposerParts;

  const { startTicker } = window.ClaudeWidgetTicker;

  const { askModelOptions, RUN_MODE_LABELS, EFFORTS } = window.ClaudeWidgetRunOptions;

  const { ui } = window.ClaudeWidgetConsoleState;
  const {
    header, linkNotice,
  } = window.ClaudeWidgetTileHeader({ paint, quotaMini, currentFace, setFace, ui, openAsk, linkButton, doLink });
  const {
    MAX_PICKS, drawPicker, pickerKey, tileCommandList,
  } = window.ClaudeWidgetSlashPicker({ api, paint, argMatches });

  const {
    MAX_ATTACH, composer,
  } = window.ClaudeWidgetComposerCard({ loadAskProjects, submitAsk, addAttachments, paint, drawPicker, pickerKey });

  const {
    sidePanel, asideStrip, noteNewAgents, recoveredPlan, openAgents,
  } = window.ClaudeWidgetSidePanel({ api, paint, toggleCollapsed, asideHide });



  // ── asking Claude from the touchscreen ─────────────────────────────────────
  // The open session's conversation (js/claude-code/claude-thread.js): re-reads after every
  // state change until the turn has closed, so the end of a reply is never missed.
  const thread = window.ClaudeThread.create({ fetchJson: (url) => api(url), onChange: () => paint() });

  async function loadAskProjects(force) {
    // Every tile's build() may ask; one request answers them all.
    if (ui.askProjectsLoading) return;
    ui.askProjectsLoading = true;
    const d = await api('/api/claude/projects' + (force ? '?refresh=1' : ''));
    ui.askProjectsLoading = false;
    widgetState.askProjects = (d && Array.isArray(d.projects)) ? d.projects : [];
    if (d && d.options) {
      widgetState.askOptions = {
        effort: d.options.effort === true,
        modes: Array.isArray(d.options.modes) ? d.options.modes.filter((m) => RUN_MODE_LABELS[m]) : [],
      };
    }
    resolveAskProject();
    paint();
  }

  // ── which session the console shows ────────────────────────────────────────
  const drafts = new Map();    // session id ('' = new session) → unsent text

  function consoleTarget() {
    if (ui.composing) return '';
    if (ui.picked) return ui.picked;
    const list = sessions();
    if (ui.autoPicked && list.some((s) => s.id === ui.autoPicked)) return ui.autoPicked;
    const first = window.ClaudeRail.sort(list.filter((s) => !s.resting))[0] || window.ClaudeRail.sort(list)[0];
    ui.autoPicked = first ? first.id : '';
    return ui.autoPicked;
  }

  // A new run gets its session id from Claude Code's first event; until then
  // the console stays on the new-session view, which shows the run's card.
  function followNewRun() {
    if (!ui.followRun) return;
    const r = runs().find((x) => x.id === ui.followRun);
    if (!r || r.state !== 'running') { ui.followRun = ''; if (r && r.sessionId) select(r.sessionId, r.project || ''); return; }
    if (r.sessionId) { ui.followRun = ''; ui.picked = r.sessionId; ui.pickedLabel = r.project || ''; ui.composing = false; }
  }

  // Applies the target: swaps the draft, points the thread at it. Idempotent,
  // so every tile's build() can call it.
  function syncSelection() {
    followNewRun();
    const id = consoleTarget();
    if (id !== widgetState.askResumeId) {
      drafts.set(widgetState.askResumeId, widgetState.askText);
      widgetState.askText = drafts.get(id) || '';
      drafts.delete(id);
      clearAttach(); widgetState.askError = '';
      widgetState.askResumeId = id;
      const s = sessionById(id);
      widgetState.askResumeLabel = s ? (s.project || '') : (id === ui.picked ? ui.pickedLabel : '');
      if (widgetState.askProjects !== null) resolveAskProject();
      if (id && ui.doneNotices.some((n) => n.id === id)) { ui.doneNotices = ui.doneNotices.filter((n) => n.id !== id); ui.topbarSig = ''; }
    }
    if (thread.id !== id) thread.open(id);
    if (drafts.size > 20) drafts.delete(drafts.keys().next().value);
  }

  function select(id, label) {
    ui.picked = id || '';
    ui.pickedLabel = label || '';
    ui.composing = false;
    if (currentFace() !== 'live') setFace('live');
    paint();
  }

  // Kept under its old name: the Chats face, the topbar marker and a finished
  // notice all open a session through it. No id = a new session.
  function openAsk(resumeId, resumeLabel, projectId) {
    if (projectId) widgetState.askProjectId = projectId;
    if (resumeId) { select(resumeId, resumeLabel); }
    else {
      ui.composing = true;
      if (currentFace() !== 'live') setFace('live');
      paint();
    }
    if (widgetState.askProjects === null) loadAskProjects(false);
  }
  function closeAsk() {
    ui.composing = false;
    paint();
  }

  // The controller polls while the session runs and settles after every state
  // change; it only needs the live record on each push.
  function syncThread() {
    if (thread.id) thread.sync(sessionById(thread.id));
  }

  // ── attachments ────────────────────────────────────────────────────────────
  // A headless run takes text, so a file becomes a file on disk plus its path in
  // the prompt. Claude reads it with its own Read tool, which means the read
  // comes back here as an approval card: attaching something does not hand it
  // over, it offers it.
  async function addAttachments(files) {
    if (!files || !files.length) return;
    widgetState.askAttachBusy = true; widgetState.askError = ''; paint();
    for (const f of files) {
      if (widgetState.askAttach.length >= MAX_ATTACH) { widgetState.askError = t('claude_attach_max', 'That is as many files as one message can carry.'); break; }
      const d = await api('/api/claude/attach?name=' + encodeURIComponent(f.name || 'file'), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f,
      });
      // An image is previewed from the file itself (a local blob), never from the saved path.
      if (d && d.ok) widgetState.askAttach.push({ name: d.name, path: d.path, size: d.size, preview: f.type && f.type.startsWith('image/') ? URL.createObjectURL(f) : '' });
      else { widgetState.askError = attachErrorText(d && d.error, f.name); break; }
    }
    widgetState.askAttachBusy = false; paint();
  }

  async function submitAsk() {
    const prompt = widgetState.askText.trim();
    if (!prompt || widgetState.askBusy) return;

    // Into the open session itself: at the end of the running turn, or as a new
    // turn the mod starts there. Either way no second process runs against the
    // same conversation.
    const mode = replyMode();
    if (mode === 'followup' || mode === 'terminal') {
      // Only a command this session knows, in a shape the tile cannot pass on, is
      // refused: a message that merely starts with a path is just a message.
      if (/^\/(?:model|effort)\s*$/.test(prompt)) {
        widgetState.askError = replyErrorText('needs_value');
        paint();
        return;
      }
      if (isKnownCommand(prompt) && !TILE_COMMAND_RE.test(prompt)) {
        widgetState.askError = t('claude_terminal_e_slash', 'Commands that start with / have to be typed in the session itself.');
        paint();
        return;
      }
      widgetState.askBusy = true; widgetState.askError = ''; paint();
      const q = await queueReply(widgetState.askResumeId, promptWithAttachments(prompt));
      widgetState.askBusy = false;
      if (q.ok) {
        widgetState.askText = ''; clearAttach();
        if (q.via === 'terminal') { thread.setAtBottom(true); thread.load(); }
      } else {
        widgetState.askError = replyErrorText(q.error);
        // The turn ended while this was typed: the next send takes the idle path.
        const s = q.error === 'session_idle' ? sessionById(widgetState.askResumeId) : null;
        if (s) s.state = 'idle';
      }
      paint();
      return;
    }

    let sendText = prompt;
    if (prompt.startsWith('/')) {
      const left = applyRunBuiltin(prompt);
      if (left === null) { widgetState.askText = ''; paint(); return; }
      if (left) sendText = left;
    }

    widgetState.askBusy = true; widgetState.askError = ''; paint();
    const d = await api('/api/claude/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: widgetState.askProjectId, prompt: promptWithAttachments(sendText),
        resume: widgetState.askResumeId, model: widgetState.askModel,
        mode: widgetState.askOptions.modes.includes(widgetState.askRunMode) ? widgetState.askRunMode : '',
        effort: widgetState.askOptions.effort ? widgetState.askEffort : '',
      }),
    });
    widgetState.askBusy = false;
    if (d && d.ok) {
      widgetState.askText = '';
      clearAttach();
      if (widgetState.askResumeId) {
        // Sending a follow-up must NOT throw you out of the conversation you are
        // reading — that was the whole point of opening it. Stay put, empty the
        // box, and let the thread poll pick the reply up: what you just sent
        // appears in it as soon as Claude Code writes the turn.
        thread.setAtBottom(true);
        thread.load();
        paint();
      } else {
        // A new run has no session id yet. The console keeps showing its card
        // and moves to the session as soon as Claude Code names it.
        ui.followRun = d.id || '';
        paint();
      }
    }
    else { widgetState.askError = runErrorText(d && d.error); paint(); }
  }

  async function stopRun(id) {
    const d = await api('/api/claude/run/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!d || !d.ok) {
      if (window.XenonToast) window.XenonToast.show({ type: 'warn', title: t('claude_run_stop_late', 'That run already finished') });
    }
  }

  function messageRow(m) {
    if (Array.isArray(m.tools) && m.tools.length && !m.text && !(m.images && m.images.length)) return toolsRow(m);
    const mine = m.role === 'user';
    const row = el('div', 'cw-msg is-' + (mine ? 'user' : 'claude') + (m.provisional ? ' is-provisional' : ''));
    const bubble = el('div', 'cw-msg-bubble');
    bubble.appendChild(el('div', 'cw-msg-who', mine
      ? t('claude_thread_you', 'you')
      : t('claude_thread_claude', 'Claude')));
    const body = el('div', 'cw-msg-text');
    // Your own words are shown as written; Claude's are markdown.
    if (mine) body.textContent = m.text;
    else if (m.text) markdownInto(body, m.text);
    if (m.truncated) {
      body.appendChild(el('div', 'cw-msg-cut', t('claude_thread_cut', 'cut short here')));
      if (!thread.full) {
        const more = el('button', 'cw-msg-more', t('claude_thread_show_all', 'Show all'));
        more.type = 'button';
        more.addEventListener('click', () => thread.showFull());
        body.appendChild(more);
      }
    }
    bubble.appendChild(body);
    if (Array.isArray(m.images) && m.images.length && threadSessionId()) bubble.appendChild(messageImages(m.images));
    row.appendChild(bubble);
    return row;
  }

  // One picture at full size over everything; a tap anywhere, the button or Esc closes it.
  function openLightbox(url) {
    const box = el('div', 'cw-lightbox');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const img = document.createElement('img');
    img.className = 'cw-lightbox-img';
    img.src = url;
    img.alt = t('claude_thread_image', 'Image in the conversation');
    const close = el('button', 'cw-lightbox-x', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', t('claude_lightbox_close', 'Close'));
    const onKey = (e) => { if (e.key === 'Escape') shut(); };
    const shut = () => { document.removeEventListener('keydown', onKey, true); box.remove(); };
    document.addEventListener('keydown', onKey, true);
    box.addEventListener('click', shut);
    box.append(img, close);
    document.body.appendChild(box);
    close.focus();
  }

  const threadSessionId = () => (thread && thread.id) || '';

  // The pictures of one message, as small tiles that open full size on a tap.
  // They are fetched from the server by id (the thread never carries the image).
  function messageImages(ids) {
    const wrap = el('div', 'cw-msg-images');
    ids.forEach((id) => {
      const url = SERVER + '/api/claude/transcript-image?session=' + encodeURIComponent(threadSessionId()) + '&id=' + encodeURIComponent(id);
      const a = document.createElement('a');
      a.className = 'cw-msg-img';
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', t('claude_thread_image', 'Image in the conversation'));
      // Opens over the dashboard, not in a new tab: the Edge and the native
      // shell have no tab bar to come back from.
      a.addEventListener('click', (e) => { e.preventDefault(); openLightbox(url); });
      const img = document.createElement('img');
      img.src = url;
      img.alt = t('claude_thread_image', 'Image in the conversation');
      img.loading = 'lazy';
      img.decoding = 'async';
      a.appendChild(img);
      wrap.appendChild(a);
    });
    return wrap;
  }

  function threadView() {
    const wrap = el('div', 'cw-thread-wrap');
    const box = el('div', 'cw-thread');
    wrap.appendChild(box);
    const sess = askSession();
    const working = !!(sess && sess.state === 'running');
    // What the session is doing right now, as the terminal prints it, lives at
    // the foot of the conversation instead of in a bar of its own above it.
    const finish = () => {
      if (sess) wrap.appendChild(window.ClaudeConsole.status(consoleHelpers(), sess, window.ClaudeRail.stateOf(sess)));
      return wrap;
    };
    const list = thread.view(sess);
    if (list === null) {
      box.appendChild(el('div', 'cw-thread-note', t('claude_thread_loading', 'Reading the conversation…')));
      return finish();
    }
    if (!list.length && !working) {
      box.appendChild(el('div', 'cw-thread-note', t('claude_thread_empty', 'Nothing to show from this session yet.')));
      return finish();
    }
    list.forEach((m) => box.appendChild(messageRow(m)));

    // Land on the newest turn — but only when the view was ALREADY at the
    // bottom. Yanking someone back down mid-sentence because a new reply
    // arrived is worse than making them scroll; they get a chip instead.
    const stick = thread.atBottom;
    requestAnimationFrame(() => { try { if (stick) box.scrollTop = box.scrollHeight; } catch {} });
    box.addEventListener('scroll', () => {
      const bottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
      if (bottom === thread.atBottom) return;
      const hadUnread = thread.unread;
      thread.setAtBottom(bottom);
      if (hadUnread && bottom) { const chip = wrap.querySelector('.cw-thread-new'); if (chip) chip.remove(); }
    }, { passive: true });
    if (thread.unread) {
      const chip = el('button', 'cw-thread-new', '↓ ' + t('claude_thread_new_reply', 'New reply'));
      chip.type = 'button';
      chip.addEventListener('click', () => {
        box.scrollTop = box.scrollHeight;
        thread.setAtBottom(true);
        chip.remove();
      });
      wrap.appendChild(chip);
    }
    return finish();
  }

  // A session open in a terminal runs only the commands the Xenon mod can run
  // for the tile (claude-bridge.js, TILE_COMMAND), so those are all it lists.
  // The same shape the bridge accepts (claude-bridge.js, TILE_COMMAND).
  // Its shape only; the bridge checks the name against what that session lists.
  const TILE_COMMAND_RE = /^\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}(?:[ ][^\r\n]{1,200})?$/;

  function isKnownCommand(text) {
    const m = /^\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})(?:\s|$)/.exec(text);
    return !!m && tileCommandList().some((c) => c.name === m[1]);
  }

  // Applies "/model x", "/effort x" or "/plan [text]" to the bar. Returns the
  // prompt that is left to send (null: nothing left), or false when the text
  // is not one of these.
  function applyRunBuiltin(text) {
    const m = /^\/(model|effort|plan)(?:\s+([\s\S]*))?$/.exec(text);
    if (!m) return false;
    const arg = (m[2] || '').trim();
    const done = () => { if (window.XenonToast) window.XenonToast.show({ type: 'info', title: t('claude_slash_set', 'Set for this run') }); };
    if (m[1] === 'plan') {
      widgetState.askRunMode = 'plan';
      done();
      return arg || null;
    }
    if (m[1] === 'model') {
      if (!/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(arg)) return false;
      widgetState.askModel = arg.toLowerCase();
    } else {
      if (!widgetState.askOptions.effort || !EFFORTS.includes(arg.toLowerCase())) return false;
      widgetState.askEffort = arg.toLowerCase();
    }
    done();
    return null;
  }

  // What a command takes after its name, offered the way Claude Code's own
  // picker does once "/model " or "/effort " is in the box. Picking one fills the
  // box with the whole command; Enter then sends it.
  // Built-in commands whose first argument is one of a fixed set (Claude Code's
  // command reference). Only a session open in a terminal runs them; a new run
  // treats /model and /effort as its own bar. Left out on purpose: /tui and
  // /voice (they change the terminal itself), /import (asks questions), and the
  // paid "ultra" review level.
  const LIVE_ARGS = {
    advisor: ['off'],
    autocompact: ['auto'],
    'claude-api': ['migrate', 'upgrade', 'managed-agents-onboard', 'prompt-audit', 'cost-optimize', 'build-eval', 'hillclimb', 'preserved-thinking-migration'],
    'code-review': ['low', 'medium', 'high', 'xhigh', 'max'],
    color: ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan', 'default'],
    context: ['all'],
    doctor: ['prompt-audit'],
    fast: ['on', 'off'],
    goal: ['clear'],
    mcp: ['reconnect', 'enable', 'disable'],
    plugin: ['list', 'install', 'enable', 'disable'],
    review: ['low', 'medium', 'high', 'xhigh', 'max'],
  };
  const MODEL_ARG = (extra) => () => askModelOptions().filter((o) => o.id)
    .map((o) => ({ value: o.id, desc: o.label, note: o.note }))
    .concat(extra.map((v) => ({ value: v, desc: v })));
  const ARG_PROVIDERS = {
    model: MODEL_ARG([]),
    advisor: () => (inLiveSession() ? MODEL_ARG(LIVE_ARGS.advisor)() : []),
    effort: () => (inLiveSession() || widgetState.askOptions.effort
      ? EFFORTS.concat(inLiveSession() ? ['auto'] : []).map((e) => ({ value: e, desc: e === 'auto' ? e : t('claude_effort', 'effort') + ' ' + e }))
      : []),
  };
  Object.keys(LIVE_ARGS).forEach((cmd) => {
    if (ARG_PROVIDERS[cmd]) return;
    ARG_PROVIDERS[cmd] = () => (inLiveSession() ? LIVE_ARGS[cmd].map((v) => ({ value: v, desc: v })) : []);
  });

  function argMatches(text) {
    const m = /^\/([A-Za-z0-9_.:-]+)[ ]+([^\s]*)$/.exec(text);
    const provider = m && Object.prototype.hasOwnProperty.call(ARG_PROVIDERS, m[1].toLowerCase()) ? ARG_PROVIDERS[m[1].toLowerCase()] : null;
    if (!provider) return null;
    const cmd = m[1].toLowerCase();
    const q = m[2].toLowerCase();
    const picks = provider()
      .filter((o) => o.value.toLowerCase().startsWith(q) || o.desc.toLowerCase().includes(q))
      .slice(0, MAX_PICKS * 2)
      .map((o) => ({ name: o.value, desc: o.desc === o.value ? (o.note || '') : (o.note ? o.desc + ' · ' + o.note : o.desc), insert: '/' + cmd + ' ' + o.value, isArg: true }));
    // A complete command in the box: close the list so Enter sends it.
    return picks.some((p) => p.insert.toLowerCase() === text.trim().toLowerCase()) ? null : picks;
  }

  // ── the console ────────────────────────────────────────────────────────────
  // The selected session, the way a terminal shows it: who it is, what it is
  // doing, what it wants from you, its plan and its last tool calls, the
  // conversation, and the prompt. Decisions render here, in the console of the
  // session that asks; a decision from ANOTHER session is a one-line bar on
  // top that switches to it, so a blocked call is never hidden behind a choice.
  function consoleHelpers() {
    return { el, t, ageNode, dur, hTok, toolIntent, endedLabel, prettyModel, modelHue, fmtMoney, ctxGauge, controls: headControls, openAgents };
  }

  // ── commands from the console header ──────────────────────────────────────
  // /model, /effort and /compact typed into the open session by the Xenon mod
  // (0.4.0+). Only while the session is idle in a terminal the mod listens in:
  // a command runs between turns, and with no mod there is nobody to run it.
  function sendCommand(sessionId, text) {
    queueReply(sessionId, text).then((r) => {
      if (!window.XenonToast) return;
      if (r.ok) window.XenonToast.show({ type: 'info', title: r.via === 'terminal' && (sessionById(sessionId) || {}).state === 'running'
        ? t('claude_cmd_queued', 'It runs when the current turn ends') : t('claude_cmd_sent', 'Sent to the session') });
      else window.XenonToast.show({ type: 'warn', title: replyErrorText(r.error) });
    });
  }

  function headControls(s) {
    if (!s || s.id !== widgetState.askResumeId || !inLiveSession() || !s.modCommands) return null;
    const id = s.id;
    // A session whose hooks have not reported a value yet has no current one:
    // a blank first entry keeps the <select> from showing its first option as if
    // it were the real setting.
    const pickOptions = (current, list, unknownLabel) => {
      if (!current) return [{ id: '', label: unknownLabel }].concat(list);
      return list.some((o) => o.id === current) ? list : list.concat([{ id: current, label: shortModel(current) }]);
    };
    return {
      modelSelect(current) {
        const opts = pickOptions(current, askModelOptions().filter((o) => o.id), t('claude_ask_model', 'Model') + ' ?');
        const sel = composerSelect('cw-ask-model-sel cw-hdr-sel', t('claude_ask_model', 'Model'), opts, current || '',
          (v) => { if (v && v !== current) sendCommand(id, '/model ' + v); });
        sel.style.setProperty('--cw-chip-hue', modelHue(current));
        return sel;
      },
      effortSelect(current) {
        const opts = pickOptions(current, EFFORTS.map((e) => ({ id: e, label: t('claude_effort', 'effort') + ' ' + e })),
          t('claude_effort', 'effort') + ' ?');
        return composerSelect('cw-ask-effort-sel cw-hdr-sel', t('claude_effort', 'effort'), opts, current || '',
          (v) => { if (v && v !== current) sendCommand(id, '/effort ' + v); });
      },
      compactButton() {
        const b = el('button', 'cw-chip cw-chip-btn', t('claude_compact', 'Compact'));
        b.type = 'button';
        b.title = t('claude_compact_hint', 'Summarise the conversation to free up context');
        b.addEventListener('click', () => sendCommand(id, '/compact'));
        return b;
      },
    };
  }

  // What you can do about a session you cannot write to from here, said once.
  function composerOrNote(s) {
    if (!(widgetState.linkState && widgetState.linkState.linked)) {
      const n = el('div', 'cw-cs-note');
      n.appendChild(el('span', '', t('claude_cs_link', 'Connect Claude Code to write to its sessions from here.')));
      n.appendChild(linkButton());
      return n;
    }
    if (s && (s.inferred || s.unlinked)) {
      return el('div', 'cw-cs-note', t('claude_cs_unlinked', 'This session started before Xenon was connected. Restart it in the terminal to reply from here.'));
    }
    return composer();
  }

  function sessionConsole(pane, id) {
    const s = sessionById(id);
    const rec = s || { id, project: widgetState.askResumeLabel };
    const st = s ? window.ClaudeRail.stateOf(s) : 'idle';
    const h = consoleHelpers();
    const who = window.ClaudeIdent.describe(rec, titles(), widgetState.askResumeLabel || t('claude_ask_session', 'session'));
    pane.classList.add('is-s' + who.slot);
    pane.appendChild(window.ClaudeConsole.head(h, rec, who, st));
    if (!s) pane.appendChild(el('div', 'cw-cs-status is-idle', t('claude_cs_closed', 'Not open in a terminal. A message continues it in the background.')));

    const decs = decisionStack(decisionsFor(id).mine);
    if (decs) pane.appendChild(decs);

    const body = el('div', 'cw-cs-body');
    body.appendChild(threadView());
    const waitingPlan = decisionsFor(id).mine.find((a) => a.kind === 'plan' && a.plan);
    let shown = s;
    if (s && !s.plan && !waitingPlan) {
      const rec = recoveredPlan(s);
      if (rec && rec.plan) shown = Object.assign({}, s, { plan: rec.plan, planAt: s.planAt || rec.at });
    }
    if (s) noteNewAgents(s, !!waitingPlan);
    const proposal = waitingPlan ? waitingPlan.plan : (shown && shown.plan) || '';
    const side = s ? sidePanel(h, shown, proposal, !!waitingPlan) : null;
    if (side) {
      if (isCollapsed('aside')) {
        body.classList.add('has-strip');
        body.appendChild(asideStrip(h, shown, proposal));
      } else {
        body.appendChild(side);
        body.classList.add('has-aside');
      }
    }
    pane.appendChild(body);

    // A resumed run writes into this session's own transcript, so once it is
    // done the thread above already shows its prompt and reply and the card
    // would repeat them. It stays while the run works (status and Stop) and when
    // it failed (the error is shown nowhere else).
    runsFor(id).slice(-1)
      .filter((r) => r.state === 'running' || r.state === 'failed')
      .forEach((r) => pane.appendChild(runCard(r)));
    if (s && s.queued) pane.appendChild(queuedRow(s));
    if (s) restoreUndelivered(s);
    pane.appendChild(composerOrNote(s));
  }

  function projectPicker() {
    if (widgetState.askProjects === null) {
      loadAskProjects(false);
      return el('div', 'cw-panel-note', t('claude_ask_loading', 'Reading your projects…'));
    }
    const list = el('div', 'cw-ask-projects');
    if (!widgetState.askProjects.length) {
      list.appendChild(el('div', 'cw-panel-note', t('claude_ask_noprojects', 'No projects found. Add a folder, or open Claude Code in one once.')));
    }
    widgetState.askProjects.slice(0, 8).forEach((p) => {
      const b = el('button', 'cw-ask-proj' + (p.id === widgetState.askProjectId ? ' is-sel' : '')); b.type = 'button';
      b.appendChild(el('span', 'cw-ask-proj-name', p.name));
      b.title = p.path;
      b.addEventListener('click', () => { widgetState.askProjectId = p.id; paint(); });
      list.appendChild(b);
    });
    if (!window.__xenonRemote) list.appendChild(folderAdder());
    return list;
  }

  // An example in this computer's own path shape (the adder is never shown remotely).
  function folderExample() {
    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'D:\\Work\\site';
    return /Mac OS X|Macintosh/i.test(ua) ? '/Users/you/site' : '/home/you/site';
  }
  function folderAdder() {
    const wrap = el('div', 'cw-ask-folder');
    if (!ui.folderOpen) {
      const b = el('button', 'cw-ask-proj cw-ask-proj-add'); b.type = 'button';
      b.textContent = '+ ' + t('claude_folder_add', 'Another folder');
      b.addEventListener('click', () => { ui.folderOpen = true; paint(); });
      wrap.appendChild(b);
      return wrap;
    }
    const input = el('input', 'cw-ask-folder-in'); input.type = 'text';
    input.placeholder = t('claude_folder_ph', 'Full path, e.g.') + ' ' + folderExample();
    input.setAttribute('aria-label', t('claude_folder_add', 'Another folder'));
    input.spellcheck = false;
    const go = el('button', 'cw-ask-proj cw-ask-proj-go', t('claude_folder_ok', 'Add')); go.type = 'button';
    const add = async () => {
      const value = input.value.trim();
      if (!value) return;
      go.disabled = true;
      const d = await api('/api/claude/folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: value }),
      });
      if (d && d.ok) {
        ui.folderOpen = false; widgetState.askError = '';
        await loadAskProjects(true);
        widgetState.askProjectId = d.id;
      } else {
        widgetState.askError = runErrorText(d && d.error);
      }
      paint();
    };
    go.addEventListener('click', add);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
      if (e.key === 'Escape') { ui.folderOpen = false; widgetState.askError = ''; paint(); }
    });
    wrap.appendChild(input);
    wrap.appendChild(go);
    requestAnimationFrame(() => { try { input.focus(); } catch {} });
    return wrap;
  }

  // No session in the console: a new one, or nothing running at all. Clawd
  // stands in the middle with the prompt under him rather than an empty panel.
  function newConsole(pane) {
    pane.classList.add('is-new');
    const hero = el('div', 'cw-hero');
    const mascot = el('span', 'cw-hero-clawd cw-clawd is-idle');
    mascot.appendChild(window.ClaudeClawd.make('cw-clawd-svg'));
    hero.appendChild(mascot);
    const none = !sessions().length;
    hero.appendChild(el('div', 'cw-hero-t', none && !ui.composing
      ? t('claude_no_sessions', 'No session running') : t('claude_new_title', 'New session')));
    hero.appendChild(el('div', 'cw-hero-s', t('claude_ask_sub', 'Whatever it runs or writes comes back here to approve')));
    if (ui.composing && !none) {
      const back = el('button', 'cw-link-btn'); back.type = 'button';
      back.textContent = t('claude_cs_back', 'Back to the sessions');
      back.addEventListener('click', closeAsk);
      hero.appendChild(back);
    }
    pane.appendChild(hero);

    const decs = decisionStack(decisionsFor('').mine);
    if (decs) pane.appendChild(decs);
    runsFor('').slice(-2).forEach((r) => pane.appendChild(runCard(r)));

    if (!(widgetState.linkState && widgetState.linkState.linked)) { pane.appendChild(composerOrNote(null)); return; }
    pane.appendChild(projectPicker());
    pane.appendChild(el('div', 'cw-thread-spacer'));
    pane.appendChild(composer());
  }

  function consolePane() {
    const pane = el('section', 'cw-console');
    const id = widgetState.askResumeId;
    const others = decisionsFor(id).others;
    if (others.length) pane.appendChild(othersBar(others));
    if (id) sessionConsole(pane, id);
    else newConsole(pane);
    return pane;
  }

  // Rail + console. A run the dashboard started whose session is not on the
  // rail yet has nowhere else to be, so the new-session console carries it.
  function missionControl() {
    syncSelection();
    const slim = isCollapsed('rail');
    const mc = el('div', 'cw-mc' + (slim ? ' is-slim' : ''));
    const list = sessions();
    if (list.length) {
      const side = el('div', 'cw-side');
      // Wide tiles only (CSS): a narrow tile already shows the rail as a strip.
      const fold = el('button', 'cw-rail-fold'); fold.type = 'button';
      fold.textContent = slim ? '›' : '‹';
      const foldLabel = slim ? t('claude_rail_open', 'Show the session list') : t('claude_rail_close', 'Hide the session list');
      fold.title = foldLabel;
      fold.setAttribute('aria-label', foldLabel);
      fold.setAttribute('aria-expanded', slim ? 'false' : 'true');
      fold.addEventListener('click', () => toggleCollapsed('rail'));
      side.appendChild(fold);
      side.appendChild(window.ClaudeRail.render({
        el, t, list, titles: titles(), selected: widgetState.askResumeId,
        fresh: new Set(ui.doneNotices.map((n) => n.id)),
        onSelect: (id, label) => select(id, label),
        ageNode, nowLine, stateLabel,
        finishedTitle: (n) => collapsibleTitle('finished', t('claude_sess_finished', 'Finished'), String(n)),
        showFinished: !isCollapsed('finished'),
      }));
      mc.appendChild(side);
    } else {
      mc.classList.add('is-solo');
    }
    mc.appendChild(consolePane());
    return mc;
  }

  // The mode and effort the run was started with, when not the defaults.
  function runChips(r) {
    const box = el('div', 'cw-cs-chips cw-run-chips');
    const mode = r.mode === 'manual'
      ? el('span', 'cw-chip', t(RUN_MODE_LABELS.manual[0], RUN_MODE_LABELS.manual[1]))
      : window.ClaudeConsole.modeChip(consoleHelpers(), r.mode);
    if (mode) box.appendChild(mode);
    if (r.effort) box.appendChild(el('span', 'cw-chip', t('claude_effort', 'effort') + ' ' + r.effort));
    return box.childNodes.length ? box : null;
  }

  // ── budget editor (fallback ceiling when there are no real windows) ────────
  function openBudget() { widgetState.editing = true; widgetState.customOpen = currentPlanKey() === 'custom'; paint(); }
  function closeBudget() { widgetState.editing = false; paint(); }
  async function postBudget(patch) {
    const d = await api('/api/claude/budget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (d && d.ok && d.budget) { if (widgetState.payload) widgetState.payload.budget = d.budget; widgetState.editing = false; paint(); }
    else if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t('claude_budget_fail', 'Could not save budget') });
  }
  // ── render ────────────────────────────────────────────────────────────────
  // ── the frame: header, faces, the connection notice ────────────────────────
  // Faces instead of one long scroll: LIVE is what is happening and what
  // needs you, USAGE is the record, CHATS is what is kept on disk. The choice is per surface and survives a
  // reload (a view preference, so localStorage, not the settings store).
  const FACE_KEY = 'xeneonedge.claude.face.v1';
  const FACES = ['live', 'usage', 'history'];
  function currentFace() {
    if (ui.face) return ui.face;
    try { ui.face = FACES.includes(localStorage.getItem(FACE_KEY)) ? localStorage.getItem(FACE_KEY) : 'live'; } catch { ui.face = 'live'; }
    return ui.face;
  }
  function setFace(f) {
    ui.face = FACES.includes(f) ? f : 'live';
    try { localStorage.setItem(FACE_KEY, ui.face); } catch { /* private mode: session only */ }
    paint();
  }

  function build() {
    const wrap = el('div', 'cw-wrap');
    if (widgetState.editing) { wrap.appendChild(budgetEditor()); return wrap; }
    if (widgetState.linkPanel) { wrap.appendChild(linkPanelView()); return wrap; }

    wrap.appendChild(header());
    const notice = linkNotice(); if (notice) wrap.appendChild(notice);

    const f = currentFace();
    // The console is the only reader of the thread; off it, stop reading.
    if (f !== 'live' && thread.id) thread.close();
    if (f === 'history') {
      // A blocked call must never wait behind a tab.
      const decs = decisionStack(approvals().filter((a) => !a.urgent));
      if (decs) wrap.appendChild(decs);
      wrap.appendChild(window.ClaudeHistory.render({ t, ago, paint, openAsk: (id, label) => openAsk(id, label, '') }));
      return wrap;
    }
    const u = widgetState.payload && widgetState.payload.usage;
    if (f === 'usage') {
      const decs = decisionStack(approvals().filter((a) => !a.urgent));
      if (decs) wrap.appendChild(decs);
      if (!u) { wrap.appendChild(el('div', 'cw-state', t('claude_reading', 'Reading local Claude Code sessions…'))); return wrap; }
      const face = usageFace(u);
      face.insertBefore(quotaPanel(), face.firstChild);
      wrap.appendChild(face);
      return wrap;
    }
    if (!widgetState.payload) {
      wrap.appendChild(el('div', 'cw-state', t('claude_reading', 'Reading local Claude Code sessions…')));
      return wrap;
    }
    wrap.appendChild(missionControl());
    return wrap;
  }

  // ── ticking ────────────────────────────────────────────────────────────────

  function paint() {
    // A finger is on the widget: see "a tap must survive an SSE push".
    if (widgetState.pressing) { widgetState.renderDeferred = true; return; }
    // Half-made choices belong to cards that still exist. Approval ids are
    // unique per request, so without this the map keeps one entry per question
    // ever asked, for as long as the page is open — the unbounded Map the
    // codebase rules out everywhere else.
    forgetSeen();
    if (qsel.size || typedAns.size) {
      const alive = new Set(approvals().map(a => a.id));
      for (const id of qsel.keys()) if (!alive.has(id)) qsel.delete(id);
      for (const id of typedAns.keys()) if (!alive.has(id)) typedAns.delete(id);
    }
    let painted = 0;
    tiles().forEach(tile => {
      const mount = tile.querySelector('.claude-widget-mount');
      if (!mount) return;
      // Nothing on a parked page is on screen, and the scroll reads just below
      // are LAYOUT reads: performing them there forces Chromium to render the
      // very subtree the parking exists to skip (the "Rendering was performed in
      // a subtree hidden by content-visibility" console flood), on every SSE
      // push, to rebuild a tile nobody can see and preserve a scroll position
      // nobody is holding. The page-change listener below repaints it at the one
      // moment it can next be looked at. The overlay, topbar marker and ticker
      // are handled outside this loop and stay live regardless of page.
      if (isParked(tile)) return;
      painted++;
      // An open dropdown (model, mode, effort) lives in the subtree a rebuild
      // replaces, so a push would snap it shut under the finger. Hold this
      // tile until it closes, then catch up.
      if (mount.querySelector('.cs-wrap.cs-open')) { paintLater(); return; }
      // A repaint rebuilds the tile, and an SSE push can land at any moment —
      // so without this the session list would jump back to the top while the
      // user is scrolling through it.
      // Every area that scrolls: the lanes, the Live face on a narrow tile, the
      // Usage face, the decisions and each card's body. Without this a push
      // threw whoever was reading the Usage face back to its top every time.
      const kept = keepScroll(mount);
      // The conversation gets the same treatment, and needs it more: it now
      // reloads itself every couple of seconds while a session works, so
      // without this every refresh would throw the reader back to the top
      // mid-paragraph. threadView() re-pins to the bottom only when the reader
      // was already there.
      const prevThread = mount.querySelector('.cw-thread');
      const keepThread = prevThread ? prevThread.scrollTop : 0;
      const focus = AK.keepFocus(mount);
      mount.replaceChildren(build());
      restoreScroll(mount, kept);
      focus();
      if (keepThread && !thread.atBottom) {
        const nextThread = mount.querySelector('.cw-thread');
        if (nextThread) nextThread.scrollTop = keepThread;
      }
    });
    // No console on screen: nobody is reading the thread, so stop polling it.
    // The next paint that shows the console opens it again.
    if (!painted && thread.id) thread.close();
    syncOverlay();
    const needsTick = !!(limits() || approvals().length || sessions().length);
    if (needsTick) startTicker(); else stopTicker();
  }

  function paintLater() {
    if (ui.laterTimer) return;
    ui.laterTimer = setTimeout(() => { ui.laterTimer = null; paint(); }, HELD_PAINT_MS);
  }

  // The rail scrolls sideways on a narrow tile, so both axes are kept.
  const HELD_PAINT_MS = 400;
  const SCROLLERS = ['.cw-rail-list', '.cw-cs-aside', '.cw-console', '.cw-usage', '.cw-hist-list', '.cw-decs', '.cw-dec-body', '.cw-dec-plan', '.cw-dec-cmd'];
  const sheet = AK.createSheet({ className: 'cw-overlay', freeze: 'claude-approval', scrollers: SCROLLERS });
  function keepScroll(root) {
    return SCROLLERS.map((sel) => Array.from(root.querySelectorAll(sel), (n) => [n.scrollTop, n.scrollLeft]));
  }
  function restoreScroll(root, kept) {
    SCROLLERS.forEach((sel, i) => {
      root.querySelectorAll(sel).forEach((n, j) => {
        const k = kept[i][j];
        if (!k) return;
        if (k[0]) n.scrollTop = k[0];
        if (k[1]) n.scrollLeft = k[1];
      });
    });
  }

  async function seed() {
    if (seedState.seedInflight) return;
    seedState.seedInflight = true;
    try {
      const d = await api('/api/claude');
      if (d) { widgetState.payload = d; widgetState.payloadAt = Date.now(); }
    } finally { seedState.seedInflight = false; }
    paint();
    loadLinkState();
  }

  // ── public API ──
  function renderWidgets() {
    if (!tiles().length) {
      seedState.seeded = false;
      stopTicker();
      // The overlay deliberately survives: a pending approval must stay
      // answerable even after the user pages away from the widget.
      if (!approvals().length) sheet.close();
      return;
    }
    paint();
    if (!seedState.seeded) { seedState.seeded = true; seed(); }
  }
  const { trackPresence, syncTopbar } = window.ClaudeWidgetTopbar({ ui, paint, openAsk });

  // ── a tap must survive an SSE push ─────────────────────────────────────────
  // A tap is pointerdown + pointerup on the SAME element. The tile, the overlay
  // and the topbar marker are rebuilt from scratch on every push, and while any
  // other session is working those arrive several times a second, so a button
  // replaced between the two halves of a tap never received its click. That was
  // "I tap Allow, or an answer, and nothing happens". While a pointer is down on
  // any of the three, rebuilds wait, and run just after the click lands.
  const PRESS_SCOPE = '.claude-widget-mount, .cw-overlay, #clock-claude';
  function renderNow() {
    syncTopbar();
    if (!tiles().length) syncOverlay();
    else paint();
  }
  function releasePress() {
    if (!widgetState.pressing) return;
    widgetState.pressing = false;
    clearTimeout(widgetState.pressTimer);
    if (!widgetState.renderDeferred) return;
    widgetState.renderDeferred = false;
    // After the click, not before it: click is dispatched after pointerup in
    // the same input task, and a timer only runs once that task is over.
    setTimeout(renderNow, 40);
  }
  document.addEventListener('pointerdown', (e) => {
    const target = e.target;
    if (!(target && target.closest && target.closest(PRESS_SCOPE))) return;
    widgetState.pressing = true;
    clearTimeout(widgetState.pressTimer);
    // A release can happen where we never hear about it (the pointer left the
    // window); rendering is never held back for longer than a long press.
    widgetState.pressTimer = setTimeout(releasePress, 2500);
  }, true);
  document.addEventListener('pointerup', releasePress, true);
  document.addEventListener('pointercancel', releasePress, true);

  function onSSE(data) {
    if (!data) return;
    widgetState.payload = data;
    widgetState.payloadAt = Date.now();
    // Presence runs on EVERY payload, before the early return below: the topbar
    // marker and the "another session answered" notice have to keep working
    // when the tile is on another page, or not on the dashboard at all.
    trackPresence();
    // A session that just started or stopped working flips whether the thread
    // needs watching, and any state change re-reads it until the turn closes.
    syncThread();
    if (widgetState.pressing) { widgetState.renderDeferred = true; return; }
    // The overlay is global, so live state has to be applied even when the tile
    // isn't mounted on the current page.
    renderNow();
  }

  // Either switch was flipped in Settings. Both surfaces are redrawn from the
  // payload already in hand — an approval that is still pending server-side
  // reappears the moment cards are turned back on, without waiting for the next
  // SSE push.
  function onSettingsChanged() {
    if (!approvalsOn()) sheet.close();
    ui.topbarSig = '';
    syncTopbar();
    paint();
  }

  // A tile on a parked page skips its rebuild in paint(), so it can be holding
  // state from before the page was parked. Landing on the page is exactly when
  // that becomes visible, so redraw it from the payload already in hand.
  window.addEventListener('xenon:page-change', () => { if (tiles().length) paint(); });

  window.ClaudeWidget = { renderWidgets, onSSE, onSettingsChanged };
})();
