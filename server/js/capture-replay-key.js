// Settings → Capture → Instant Replay: the shortcut that saves the replay from
// any app (hubSettings.capture.replayKey, Ctrl+Shift+F10 by default). Tap the
// button, press the keys, saved; Esc cancels. The same rules and refusals as a
// Deck key's shortcut (js/deck-shortcuts.js, js/deck-editor-shortcut.js), and
// the line under it says what the server made of it. window.CaptureReplayKey.
(function () {
  'use strict';

  const S = () => window.DeckShortcuts;
  const E = () => window.DeckEditorShortcut;
  const $id = (id) => document.getElementById(id);
  const isMac = () => /Mac/i.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent || '');
  const base = () => (typeof SERVER !== 'undefined' ? SERVER : '');
  // capture-settings.js REPLAY_KEY (a test pins the two equal).
  const DEFAULT_KEY = 'ctrl+shift+f10';
  const RECHECK_MS = 1500;
  let value = '';        // 'off' or the canonical combo
  let replayOn = false;
  let status = null;     // GET /pages/hotkey-status
  let recording = false;
  let said = null;       // a refusal shown until the next render: [key, fill]

  async function readStatus() {
    try {
      const r = await fetch(base() + '/pages/hotkey-status');
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  // Something else in the table on this combo (a Deck key, a page, the overlay).
  function clashWith(combo) {
    const list = status && Array.isArray(status.taken) ? status.taken : [];
    return list.find((b) => b.slot !== 'replay' && S().normalizeShortcut(b.combo) === combo) || null;
  }

  // Why a pressed combo cannot be the replay's, as [i18n key, fill], or null.
  function refusalOf(combo) {
    const c = S().normalizeShortcut(combo);
    if (!c) return ['deck_shortcut_invalid'];
    const owner = S().reservedBy(c);
    if (owner) return ['deck_shortcut_res_' + owner];
    const other = clashWith(c);
    if (!other) return null;
    if (other.slot === 'overlay') return ['settings_replay_key_used_overlay'];
    if (other.keyId) {
      const key = ((status && status.deck) || []).find((d) => d.keyId === other.keyId);
      return key && key.title ? ['deck_shortcut_used_key', key.title] : ['deck_shortcut_st_duplicate'];
    }
    return ['deck_shortcut_used_other'];
  }

  // The line under the label when nothing is being recorded.
  function stateKey() {
    if (value === 'off') return 'settings_replay_key_none_hint';
    if (!replayOn) return 'settings_replay_key_idle';
    if (!status) return '';
    if (clashWith(value)) return 'deck_shortcut_st_duplicate';
    const state = (status.slots || {}).replay;
    if (!state) return status.state === 'helper_missing' ? 'deck_shortcut_st_helper' : 'deck_shortcut_st_full';
    // Still registering (right after a save): nothing to say yet, refresh() asks again.
    if (state === 'starting' || state === 'retrying') return '';
    return E() ? E().stateKey(state) : '';
  }

  function paint() {
    const btn = $id('settings-replay-key');
    const off = $id('settings-replay-key-off');
    const line = $id('settings-replay-key-state');
    if (btn) {
      btn.textContent = recording ? t('deck_shortcut_press', 'Press the keys…')
        : value === 'off' ? t('deck_shortcut_record', 'Record a shortcut') : S().formatShortcut(value, isMac());
      btn.classList.toggle('is-recording', recording);
      btn.setAttribute('aria-pressed', recording ? 'true' : 'false');
    }
    if (off) {
      off.hidden = recording;
      off.textContent = value === 'off'
        ? t('settings_replay_key_reset', 'Use {combo}').replace('{combo}', S().formatShortcut(DEFAULT_KEY, isMac()))
        : t('settings_replay_key_off', 'Turn off');
    }
    if (!line) return;
    const key = recording ? 'deck_shortcut_press_hint' : said ? said[0] : stateKey();
    let text = key ? t(key, '') : '';
    if (said && said[1]) text = text.replace('{name}', said[1]);
    line.textContent = text;
    line.hidden = !text;
    const bad = !recording && (!!said || ['deck_shortcut_st_duplicate', 'deck_shortcut_st_full', 'deck_shortcut_st_taken',
      'deck_shortcut_st_error', 'deck_shortcut_st_helper', 'deck_shortcut_st_unsupported'].includes(key));
    line.classList.toggle('settings-note-warn', bad);
  }

  async function save(raw) {
    const res = await apiJson('/capture/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replayKey: raw }),
    });
    if (res && res.ok) setSettingsStatus('settings_saved', 'ok');
    else if (res && res.error === 'reserved' && res.owner) { said = ['deck_shortcut_res_' + res.owner]; paint(); return; }
    else setSettingsStatus('settings_capture_failed', 'error');
    if (window.CaptureSettingsPane) window.CaptureSettingsPane.show();
  }

  function swallow(e) { e.preventDefault(); e.stopImmediatePropagation(); }

  function stop() {
    recording = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', swallow, true);
  }

  function onKey(e) {
    swallow(e);
    if (e.key === 'Escape') { stop(); paint(); return; }
    const combo = S().comboFromKeyEvent(e);
    if (!combo) return;   // only modifiers so far, or a key no registrar can name
    stop();
    const c = S().normalizeShortcut(combo);
    if (c && c === value) { paint(); return; }
    said = refusalOf(combo);
    paint();
    if (!said) save(c);
  }

  function record() {
    if (!S()) return;
    if (recording) { stop(); paint(); return; }
    said = null;
    recording = true;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', swallow, true);
    paint();
  }

  // The second button: turns the shortcut off, or brings the default back.
  function toggleOff() {
    said = null;
    save(value === 'off' ? '' : 'off');
  }

  // From the pane's render(): the values the server holds.
  function render(o) {
    value = (o && o.replayKey) || 'off';
    replayOn = !!(o && o.replay);
    said = null;
    if (recording) stop();
    paint();
    refresh(true);
  }

  // The server's verdict; asked once more while the combo is still registering.
  function refresh(again) {
    readStatus().then((s) => {
      status = s;
      if (!recording) paint();
      const state = s && s.slots ? s.slots.replay : '';
      if (again && (state === 'starting' || state === 'retrying')) setTimeout(() => refresh(false), RECHECK_MS);
    });
  }

  window.CaptureReplayKey = { render, record, toggleOff, refusalOf };
})();
