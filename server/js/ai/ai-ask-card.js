// Bit's question with real alternatives, drawn the way the Maker draws it:
// numbered answers with what each one means, the person's own words, or the
// choice left to Bit. Only replies whose [[answer | note]] lines carry notes get
// it (js/ai/ai-reply-choices.js); a plain yes or no stays a row of one-tap answers.
// Clicks and keys are delegated, so the chat mirrors in duplicated tiles answer too.
(function () {
  const composer = () => document.getElementById('ai-text-input');
  // A screen name as long as pumpSet takes (js/capabilities/catalog-pump.js SCREEN).
  const SCREEN_MAX = 24;

  function row(n, label, note, best) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-choice ai-ask-row';
    btn.dataset.answer = label;
    const num = document.createElement('span');
    num.className = 'ai-ask-n';
    num.textContent = String(n);
    const txt = document.createElement('span');
    txt.className = 'ai-ask-txt';
    const lbl = document.createElement('span');
    lbl.className = 'ai-ask-lbl';
    lbl.textContent = label;
    if (best) {
      const pick = document.createElement('small');
      pick.textContent = t('ai_ask_pick');
      lbl.appendChild(pick);
    }
    txt.appendChild(lbl);
    if (note) {
      const line = document.createElement('span');
      line.className = 'ai-ask-note';
      line.textContent = note;
      txt.appendChild(line);
    }
    btn.append(num, txt);
    return btn;
  }

  function ownRow(n) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-ask-row ai-ask-own';
    const num = document.createElement('span');
    num.className = 'ai-ask-n';
    num.textContent = String(n);
    const txt = document.createElement('span');
    txt.className = 'ai-ask-note';
    txt.textContent = t('ai_ask_own');
    btn.append(num, txt);
    return btn;
  }

  function build(choices, notes) {
    const card = document.createElement('div');
    card.className = 'ai-choices ai-ask';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', t('ai_ask_label'));
    card.tabIndex = -1;
    choices.forEach((c, i) => card.appendChild(row(i + 1, c, notes[i], i === 0)));
    card.appendChild(ownRow(choices.length + 1));
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'ai-choice ai-ask-leave';
    leave.dataset.answer = t('ai_ask_leave');
    leave.textContent = t('ai_ask_leave');
    card.appendChild(leave);
    return card;
  }

  // The keys work at once when the person was waiting in the empty box; words
  // already being typed there are never interrupted.
  function settle(card) {
    const box = composer();
    const at = document.activeElement;
    if (at === document.body || (at === box && !box.value)) card.focus({ preventScroll: true });
  }

  function writeOwn() {
    const box = composer();
    if (box) box.focus();
  }

  function onKey(e) {
    const card = e.target && e.target.closest && e.target.closest('.ai-ask');
    if (!card || e.ctrlKey || e.metaKey || e.altKey) return;
    const rows = [...card.querySelectorAll('.ai-ask-row')];
    const act = AiReplyChoices.keyAction(e.key, rows.length - 1);
    if (!act) return;
    // The letter itself lands in the box the focus moved to.
    if (act.type) { writeOwn(); return; }
    e.preventDefault();
    if (act.pick !== undefined) rows[act.pick].click();
    else if (act.own) writeOwn();
    else if (act.leave) card.querySelector('.ai-ask-leave').click();
    else rows[(rows.indexOf(e.target) + act.move + rows.length) % rows.length].focus();
  }

  // A file only the person can pick, Bit cannot: today a picture or GIF for a pump's screen
  // (the choose_pump_picture action). One row opens their file picker; the file goes up as the
  // menu's "Use your own picture or GIF" sends it (XenonMenuPumps.upload), then becomes what
  // the pump shows normally. Its answer is said under the row. Not one of the offered answers
  // (.ai-choice sends its words, and a new message clears those): it stays until used.
  function pumpPicture(args) {
    const chat = document.getElementById('ai-chat');
    if (!chat) return;
    const card = document.createElement('div');
    card.className = 'ai-ask-file';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', t('xmenu_pump_own'));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-ask-pick';
    btn.dataset.pumpScreen = typeof args?.screen === 'string' ? args.screen.slice(0, SCREEN_MAX) : '';
    btn.textContent = t('xmenu_pump_own');
    const note = document.createElement('span');
    note.className = 'ai-ask-note';
    note.setAttribute('role', 'status');
    card.append(btn, note);
    // Actions run before the reply is drawn: the row goes under the words that announce it.
    setTimeout(() => {
      chat.appendChild(card);
      chat.scrollTop = chat.scrollHeight;
      if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
    }, 0);
  }

  async function sendPumpPicture(btn, file) {
    const note = btn.parentElement.querySelector('.ai-ask-note');
    const say = (key) => { if (note) note.textContent = t(key); };
    const Pumps = window.XenonMenuPumps;
    if (!Pumps) { say('xmenu_pump_own_failed'); return; }
    btn.disabled = true;
    say('xmenu_pump_own_busy');
    try {
      const up = await Pumps.upload(SERVER, file);
      if (!up.ok) { say(up.bad ? 'xmenu_pump_own_bad' : 'xmenu_pump_own_failed'); return; }
      const patch = JSON.stringify({ base: { face: 'picture', items: [up.url] } });
      const r = await fetch(SERVER + '/actions/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'pumpSet', screen: btn.dataset.pumpScreen, patch }),
      });
      const d = await r.json().catch(() => null);
      say(d?.ok ? 'ai_ask_file_done' : 'xmenu_pump_own_failed');
    } catch {
      say('xmenu_pump_own_failed');
    } finally {
      btn.disabled = false;
    }
  }

  // The picker opens inside the tap itself, the only moment a page may open one.
  function pickPumpPicture(btn) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = window.XenonMenuPumps?.PICTURE_TYPES || 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) sendPumpPicture(btn, file);
    }, { once: true });
    input.click();
  }

  document.addEventListener('keydown', onKey);
  document.addEventListener('click', (e) => {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('.ai-ask-own')) writeOwn();
    const pick = e.target.closest('.ai-ask-pick');
    if (pick && !pick.disabled) pickPumpPicture(pick);
  });

  window.AiAskCard = { build, settle, pumpPicture };
})();
