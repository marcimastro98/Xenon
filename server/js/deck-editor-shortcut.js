'use strict';
// Key editor: the Keyboard shortcut card (What it does tab). One button: tap it,
// press the keys, done; Esc cancels. A combination the rules refuse, or that
// something else already holds, is never stored: the line under the button says
// why. The editor owns the key; collect(key) writes `key.shortcut`.
// window.DeckEditorShortcut.
(function () {
  const S = () => window.DeckShortcuts;
  const isMac = () => /Mac/i.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent || '');
  const base = () => (typeof SERVER !== 'undefined' ? SERVER : '');

  // What the server last said about every shortcut (GET /pages/hotkey-status).
  async function readStatus() {
    try {
      const r = await fetch(base() + '/pages/hotkey-status');
      const status = r.ok ? await r.json() : null;
      // This PC's AltGr keys: a Ctrl+Alt letter none of its keyboards types is allowed.
      if (status && S()) S().useAltGrKeys(status.altGrKeys);
      return status;
    } catch { return null; }
  }

  // The sentence for a key's own shortcut, from the server's verdict.
  function stateKey(state) {
    if (state === 'listening') return 'deck_shortcut_st_listening';
    if (state === 'starting' || state === 'retrying') return 'deck_shortcut_st_pending';
    if (state === 'taken') return 'deck_shortcut_st_taken';
    if (state === 'full') return 'deck_shortcut_st_full';
    if (state === 'clash' || state === 'duplicate') return 'deck_shortcut_st_duplicate';
    if (state === 'helper_missing') return 'deck_shortcut_st_helper';
    if (state === 'unsupported_de') return 'deck_shortcut_st_unsupported';
    return 'deck_shortcut_st_error';
  }

  // Why a freshly pressed combo cannot be used, or '' when it can. `status` is
  // the server's table; the key's own current combo is never "in use".
  function refusal(combo, keyId, status) {
    const c = S().normalizeShortcut(combo);
    if (!c) return { key: 'deck_shortcut_invalid' };
    const owner = S().reservedBy(c);
    if (owner) return { key: 'deck_shortcut_res_' + owner };
    const taken = (status && Array.isArray(status.taken) ? status.taken : [])
      .find((b) => (S().normalizeShortcut(b.combo) || String(b.combo || '').toLowerCase()) === c && (!keyId || b.keyId !== keyId));
    if (taken) return { key: taken.keyId ? 'deck_shortcut_used_key' : 'deck_shortcut_used_other' };
    return null;
  }

  function buildCard(ui, existing) {
    const { t, section } = ui;
    const keyId = existing && typeof existing.id === 'string' ? existing.id : '';
    let value = (existing && S() && S().normalizeShortcut(existing.shortcut)) || '';
    const saved = value;
    let status = null;
    let recording = false;
    const downs = new Set();   // keydowns seen while recording (swallowedCombo)

    const el = section('deck_shortcut_title');
    const row = document.createElement('div'); row.className = 'deck-ed-hotkey-row';
    const rec = document.createElement('button'); rec.type = 'button';
    rec.className = 'deck-ed-btn deck-ed-shortcut-rec';
    const clear = document.createElement('button'); clear.type = 'button';
    clear.className = 'deck-ed-hotkey-clear'; clear.innerHTML = window.DeckIcons.CLOSE_MARK;
    clear.setAttribute('aria-label', t('deck_shortcut_clear')); clear.title = t('deck_shortcut_clear');
    row.appendChild(rec); row.appendChild(clear);
    const line = document.createElement('div'); line.className = 'deck-ed-hint deck-ed-shortcut-state';
    line.setAttribute('aria-live', 'polite');
    el.appendChild(row); el.appendChild(line);

    function say(textKey, bad, fill) {
      let txt = textKey ? t(textKey) : '';
      if (fill) txt = txt.replace('{name}', fill);
      line.textContent = txt;
      line.classList.toggle('is-bad', !!bad);
    }

    // The line under the button when nothing is being recorded.
    function sayState() {
      if (!value) { say('deck_shortcut_hint', false); return; }
      if (value !== saved) { say('deck_shortcut_st_pending', false); return; }
      const mine = status && Array.isArray(status.deck) ? status.deck.find((d) => d.keyId === keyId) : null;
      if (!mine) { say(status ? 'deck_shortcut_st_pending' : '', false); return; }
      say(stateKey(mine.state), mine.state !== 'listening' && mine.state !== 'starting' && mine.state !== 'retrying');
    }

    function paint() {
      rec.classList.toggle('is-recording', recording);
      rec.textContent = recording ? t('deck_shortcut_press')
        : (value ? S().formatShortcut(value, isMac()) : t('deck_shortcut_record'));
      rec.setAttribute('aria-pressed', recording ? 'true' : 'false');
      clear.hidden = recording || !value;
    }

    function stop() {
      recording = false;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      downs.clear();
      paint();
    }

    // Window, capture phase: ahead of the page. The window's own keys wait for `recording`.
    function swallow(e) { e.preventDefault(); e.stopImmediatePropagation(); }

    // A keyup with no keydown: something else on the PC holds that combination.
    function onKeyUp(e) {
      swallow(e);
      const pressed = S().keyupPress(e, downs);
      if (pressed) { takeCombo(pressed); return; }
      const combo = S().swallowedCombo(e, downs);
      if (!combo) return;
      const why = refusal(combo, keyId, status);
      stop();
      sayRefusal(why || { key: 'deck_shortcut_held' }, combo);
    }

    function sayRefusal(why, combo) {
      const found = why.key === 'deck_shortcut_used_key' && status
        ? (status.deck || []).find((d) => d.combo === S().normalizeShortcut(combo)) : null;
      // A key with no title is still another key: say so without a name.
      say(why.key === 'deck_shortcut_used_key' && !(found && found.title) ? 'deck_shortcut_st_duplicate' : why.key, true, found ? found.title : '');
    }

    function onKey(e) {
      swallow(e);
      downs.add(String(e.code || ''));
      if (e.key === 'Escape') { stop(); sayState(); return; }
      const combo = S().comboFromKeyEvent(e);
      if (!combo) return;   // still holding modifiers, or a key no registrar can name
      takeCombo(combo);
    }

    function takeCombo(combo) {
      const why = refusal(combo, keyId, status);
      stop();
      if (why) { sayRefusal(why, combo); return; }
      value = S().normalizeShortcut(combo);
      paint();
      sayState();
    }

    rec.addEventListener('click', () => {
      if (recording) { stop(); sayState(); return; }
      recording = true;
      say('deck_shortcut_press_hint', false);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('keyup', onKeyUp, true);
      paint();
    });
    clear.addEventListener('click', () => { value = ''; paint(); sayState(); });

    paint();
    sayState();
    readStatus().then((s) => { status = s; if (!recording) sayState(); });

    return {
      el,
      // Write the shortcut into the key being saved (normalizeKey re-checks it).
      collect(key) { if (value) key.shortcut = value; },
      // Saving needs a shortcut: says so under the button when there is none.
      ask() { if (!value) say('deck_shortcut_needed', true); return !!value; },
      // Every key belongs to the recording, Esc and Tab included.
      recording: () => recording,
      // The editor closed: let go of the keyboard.
      dispose() { if (recording) stop(); },
    };
  }

  window.DeckEditorShortcut = { buildCard, refusal, stateKey };
})();
