// Sends one message to the AI and handles everything that comes back.
'use strict';

// fromVoice=true → speak the reply aloud; false (text chat) → silent
// audioParts (optional) → spoken request sent as audio; Gemini transcribes + answers in one call
async function aiSendMessage(userText, fromVoice, audioParts) {
  const text = String(userText || '').trim();
  const hasAudio = Array.isArray(audioParts) && audioParts.length > 0;
  if (!text && _aiPendingImages.length === 0 && !hasAudio) return;
  // A turn spoken in a voice session belongs to the voice screen: the chat is a
  // separate conversation, so nothing of it is written there. The generation
  // lets a reply that lands after the user closed the session be dropped.
  const voiceTurn = !!fromVoice && _aiVoiceSessionActive;
  const voiceGen = _aiVoiceGen;
  _aiClearChoices();
  _aiDropWelcome();

  // Blank on every loaded page: the key is server-only and the server swaps the
  // stored one in. It is still SENT, so a key typed a second ago works before
  // the save has round-tripped. The gate is `geminiKeyReady`, never the value —
  // testing the value here is what would turn a perfectly configured tablet into
  // "invalid key" on every turn.
  const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
  if (!_aiProviderReady() && _aiProviderCfg().provider === 'gemini') {
    _aiAppendBubble('assistant', t('ai_key_invalid'));
    return;
  }

  // If screen mode is active, replace the previous auto-screenshot with a fresh one
  if (_aiScreenMode) {
    _aiPendingImages = _aiPendingImages.filter(img => !img.fromScreenMode);
    await _aiDoCapture(_aiScreenMonitor, true);
  }

  // Capture and clear pending attachments before any async ops.
  // attachParts keeps the full objects (name/isImage) for the bubble preview;
  // imageParts is the slimmed payload (mimeType + data) sent to the model.
  const attachParts = _aiPendingImages.slice();
  const imageParts = attachParts.map(({ mimeType, data }) => ({ mimeType, data }));
  _aiPendingImages = [];
  _aiUpdateAttachPreview();

  // Sticky documents: attachments aren't kept in the text history (too large),
  // so a follow-up like "and the second page of that PDF?" used to lose the file.
  // Keep real (non-screenshot) attachments available for a couple of follow-up
  // turns by transparently re-sending them. Bounded and light — no storage, no RAG.
  const freshAttach = attachParts.filter(p => !p.fromScreenMode);
  const freshDocs = freshAttach.map(({ mimeType, data }) => ({ mimeType, data }));
  let sentImageParts = imageParts;
  let sentAttach = attachParts;
  if (freshDocs.length > 0) {
    _aiStickyDocs = freshDocs;
    _aiStickyAttach = freshAttach;
    _aiStickyTurns = AI_STICKY_TURNS;
  } else if (_aiStickyDocs && _aiStickyTurns > 0 && !hasAudio) {
    sentImageParts = _aiStickyDocs;   // carry the recent document(s) forward
    sentAttach = _aiStickyAttach;
    _aiStickyTurns -= 1;
  }

  if (!voiceTurn) {
    if (text) _aiAppendBubble('user', text, attachParts);
    else if (hasAudio) _aiAppendBubble('user', '🎤');
    else _aiAppendBubble('user', '', attachParts);
    setAiStatus('thinking');
  }
  document.body.classList.add('ai-active');

  // Only store text in history (audio/images are too large to keep for context).
  // For a spoken turn we store the wake-word command head if we have it, else a
  // placeholder; the model's own reply (stored below) carries the rest of context.
  if (text) {
    aiConversationHistory.push({ role: 'user', parts: [{ text }] });
  } else if (hasAudio) {
    aiConversationHistory.push({ role: 'user', parts: [{ text: '[richiesta vocale]' }] });
  } else {
    aiConversationHistory.push({ role: 'user', parts: [{ text: '[immagine allegata]' }] });
  }
  if (aiConversationHistory.length > AI_MAX_HISTORY) {
    aiConversationHistory = aiConversationHistory.slice(-AI_MAX_HISTORY);
  }
  // Fold older turns into a running summary in the background so long
  // conversations stay coherent without an ever-growing context (and without
  // blocking this turn — the summary is applied for subsequent turns).
  _aiMaybeSummarize(apiKey);

  // The turn's id lets the chat show how far a long creation has got and pick
  // its answer up again after a reload or a dropped connection (ai-turn-wait.js).
  const turnWait = window.AiTurnWait;
  const turnId = turnWait ? turnWait.newId() : '';
  let stopWatch = null;
  let recovering = false;
  if (turnWait) {
    turnWait.remember(turnId);
    if (!voiceTurn) stopWatch = turnWait.watch(turnId, (st) => setAiStatus('working', st));
  }
  const running = (!voiceTurn && turnId) ? { id: turnId, ctrl: new AbortController(), stopped: false } : null;
  if (running) _aiSetTurnRunning(running);
  const startedAt = Date.now();
  // The balance before the turn, for the cost line under a reply paid with Scintille.
  const sparksBefore = window.XenonCredits && XenonCredits.active() ? XenonCredits.state.balance : null;
  try {
    const featureFlags = _aiFeatureFlags();
    // The attached pictures, fitted so Xenon AI can put them in what it creates.
    const pictures = window.AiPictures ? await AiPictures.aiPicturesForSend(sentAttach) : [];
    let response;
    try {
      response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: apiKey,
        messages: aiConversationHistory,
        voice: !!fromVoice,
        lang: (typeof lang !== 'undefined' && lang) || 'en',
        // The deck's profiles live only in the browser, so tell the server which
        // exist this turn — it injects them into the prompt so Xenon can switch
        // by exact name via the switch_deck_profile client action.
        deckProfiles: (window.Deck && window.Deck.listProfiles) ? window.Deck.listProfiles() : [],
        // Bit on the main screen with no dashboard (js/screen-bit.js): the server
        // answers the dashboard-only actions with needs_dashboard (ai-surface.js).
        ...(window.AiSurface === 'screen' ? { surface: 'screen' } : {}),
        // Opt-in advanced features: the server only declares the extra tools
        // (Genesis, Guardian …) for flags that are present and true.
        ...(Object.keys(featureFlags).length > 0 ? { features: featureFlags } : {}),
        // Genesis needs the live page/widget map (client-owned, like the deck).
        ...(featureFlags.genesis && window.Genesis ? { dashboardState: window.Genesis.describeState() } : {}),
        ..._aiProviderCfg(),
        // Rolling summary of earlier turns that scrolled out of the window, so
        // the model keeps the thread of a long conversation. Empty until the
        // first fold happens.
        ...(aiConversationSummary ? { summary: aiConversationSummary } : {}),
        ...(aiToolGroups.length ? { toolGroups: aiToolGroups } : {}),
        ...(sentImageParts.length > 0 ? { imageParts: sentImageParts } : {}),
        ...(pictures.some(Boolean) ? { pictures } : {}),
        ...(hasAudio ? { audioParts } : {}),
        ...(turnId ? { turnId } : {}),
      }),
      ...(running ? { signal: running.ctrl.signal } : {}),
      });
    } catch (netErr) {
      if (running && running.stopped) { _aiAfterStop(turnId); return; }
      // The connection dropped, but the server goes on with the turn: wait for
      // its answer instead of reporting a failure that is not one.
      if (turnWait && !voiceTurn) { recovering = true; _aiAwaitLostTurn(turnId, startedAt); return; }
      throw netErr;
    }

    const data = await response.json().catch(() => ({}));
    if (running && running.stopped) { _aiAfterStop(turnId); return; }
    // A turn on credits carries the balance left: every chip shows it at once.
    if (window.XenonCredits && Number.isFinite(data.credits)) XenonCredits.set(data.credits);
    if (Array.isArray(data.toolGroups)) aiToolGroups = data.toolGroups.filter((g) => typeof g === 'string').slice(0, 16);
    if (voiceTurn && voiceGen !== _aiVoiceGen) return; // the session closed while this was thinking

    if (!response.ok) {
      // A later round failed, but the widget an earlier one made still lands.
      if (Array.isArray(data.clientActions) && data.clientActions.length) {
        _aiRunMadeActions(data.clientActions);
        if (!voiceTurn) _aiAppendBubble('assistant', t('ai_partial_done'));
      }
      const errMsg = (data && data.error) ? data.error : `${t('ai_http_error')} ${response.status}`;
      const err = new Error(errMsg);
      if (data && data.detail) err.detail = String(data.detail);
      throw err;
    }

    let pickerOpened = false;
    let deferredPickerScreens = null;
    let mutated = false; // a refresh_* action means Xenon changed persisted state
    if (Array.isArray(data.clientActions)) {
      for (const action of _aiActionsToRun(data.clientActions)) {
        if (action.action === 'show_monitor_picker') {
          pickerOpened = true;
          // Defer the modal so it appears together with Xenon's spoken question
          // ("which monitor?") instead of popping up a beat before the voice.
          if (fromVoice) { deferredPickerScreens = (action.args && action.args.screens) || []; continue; }
        }
        if (/^refresh_/.test(action.action)) mutated = true;
        _aiExecuteClientAction(action.action, action.args || {});
      }
    }

    if (data.newContent) {
      aiConversationHistory.push(data.newContent);
    } else if (data.text) {
      aiConversationHistory.push({ role: 'model', parts: [{ text: data.text }] });
    }

    const replyText = data.text || '';
    if (replyText) {
      if (!voiceTurn) {
        const ranActions = Array.isArray(data.clientActions) && data.clientActions.length > 0;
        _aiAppendBubble('assistant', replyText, null, ranActions ? 'done' : 'idle');
        _aiNoteToolsOff(data.toolsOff);
        if (window.BitChat) {
          if (ranActions) BitChat.react('nod');
          if (BitChat.crossedLow && BitChat.crossedLow(sparksBefore, data.credits)) _aiAppendBuyRow(t('xai_low'));
        }
      }
      // Offer to undo a state-changing action (notes overwrite, bulk clear, a
      // just-created task) in the text chat, where a chip can sit under the reply.
      if (mutated && !fromVoice) _aiMaybeShowUndo();
      const ttsOn = hubSettings && hubSettings.aiTtsEnabled === true;
      if (fromVoice) {
        // After speaking, keep listening for a few seconds so the user can ask a
        // follow-up without repeating the wake word (same chat, same history).
        // The mic re-opens only AFTER TTS finishes — never during — so the
        // assistant's own voice never bleeds into the recording. If the user
        // stays silent, _aiStartFollowupListen ends the session on its own.
        // Exception: when a monitor picker is open the user must tap a choice, so
        // we don't re-open the mic (it would compete with the picker).
        const afterAnswer = () => {
          if (!_aiVoiceSessionActive) return;
          // A monitor picker or a PC-Control confirmation card is modal: don't
          // re-open the mic behind it — listening resumes when it's closed.
          if (pickerOpened || _aiPcConfirmOpen) { _aiVoiceState(''); return; }
          _aiStartFollowupListen();
        };
        // Hold the deferred monitor picker until the voice actually starts.
        _aiPendingPicker = deferredPickerScreens;
        if (ttsOn) {
          // Hold the reply text until speak_start fires so text and voice appear
          // at the same moment. _aiPendingVoiceReply is cleared at the start of
          // every new turn (wake trigger + new request) so it can never carry a
          // stale value across sessions.
          const spokenReply = window.AiReplyChoices ? AiReplyChoices.spoken(replyText) : replyText;
          _aiPendingVoiceReply = spokenReply;
          _aiSpeak(spokenReply, () => {
            // No voice came out (the speech service failed or was cut): the reply
            // still has to be seen, so show it and leave time to read it.
            if (_aiPendingVoiceReply && _aiVoiceSessionActive) {
              _aiVoiceSetReply(_aiPendingVoiceReply);
              _aiPendingVoiceReply = '';
              _aiVoiceState('');
              setTimeout(afterAnswer, Math.min(6000, 1500 + replyText.length * 40));
              return;
            }
            afterAnswer();
          });
        } else {
          if (_aiVoiceSessionActive) {
            if (deferredPickerScreens) { _aiVoiceSetReply(replyText); _aiShowVoiceMonitorPicker(deferredPickerScreens); _aiPendingPicker = null; }
            else if (!pickerOpened) _aiVoiceState('speaking');
          }
          setTimeout(afterAnswer, 600);
        }
      }
    } else {
      // The turn produced no text. Never leave the chat silent: the thinking dots
      // simply vanishing reads as a lost message, with nothing to retry from. A
      // turn that only ran dashboard actions is exempt — the user watched those
      // happen, so a "no answer" notice there would be wrong.
      const ranActions = Array.isArray(data.clientActions) && data.clientActions.length > 0;
      if (voiceTurn) {
        if (!ranActions && _aiVoiceSessionActive) _aiVoiceShowError(t('ai_no_reply'));
        else if (_aiVoiceSessionActive && !pickerOpened) _aiEndVoiceSession();
      } else if (!ranActions) {
        _aiAppendBubble('assistant', t('ai_no_reply'), null, 'worry');
      }
    }

    if (!voiceTurn) setAiStatus('');
  } catch (e) {
    if (voiceTurn && voiceGen !== _aiVoiceGen) return;
    const msg = _aiFormatApiError(e);
    // Close the voice session on error so it doesn't hang waiting for a
    // follow-up, after showing why on the voice screen.
    if (voiceTurn) {
      if (_aiVoiceSessionActive) _aiVoiceShowError(msg);
    } else {
      _aiAppendBubble('assistant', msg, null, 'worry');
      _aiFollowNoCode(e);
      if (_aiOutOfSparks(e)) _aiAppendBuyRow('');
      else if (text && !hasAudio) _aiAppendRetry(text);
      setAiStatus('error');
      setTimeout(() => setAiStatus(''), 3500);
    }
  } finally {
    if (stopWatch) stopWatch();
    if (running && _aiRunningTurn === running) _aiSetTurnRunning(null);
    if (!recovering) {
      document.body.classList.remove('ai-active');
      if (turnWait) turnWait.forget(turnId);
      if (!voiceTurn && !(running && running.stopped)) _aiToastIfUnseen(startedAt);
    }
  }
}
