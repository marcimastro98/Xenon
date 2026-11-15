// The field of the deck editor that takes a key combination: pressed on the keyboard or typed,
// shown as keycaps.
'use strict';

window.DeckEditorHotkeyField = (wrapper) => {
    const { t } = wrapper;

    // Map a KeyboardEvent's main (non-modifier) key to a hotkey token, or null.
    const _HK_NAMED = { ' ': 'space', Enter: 'enter', Escape: 'esc', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    function hotkeyToken(e) {
      const k = e.key;
      if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null;   // modifier
      if (/^[a-zA-Z]$/.test(k)) return k.toLowerCase();
      if (/^[0-9]$/.test(k)) return k;
      if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) return k.toLowerCase();
      return _HK_NAMED[k] || null;
    }
    // Hotkey composer for the `keys` param. Press-to-record is impossible for any
    // combo with Win (Win+D, Win+Shift+arrow…): holding Win physically fires the OS
    // shortcut before the page ever sees the keydown, so the user can't set it. Here
    // the modifiers are toggle chips (no physical Win press) and only the single main
    // key is captured by tapping the field. Stored format is unchanged: "win+d".
    const _HK_MODS = [
      { id: 'ctrl', label: 'Ctrl' },
      { id: 'shift', label: 'Shift' },
      { id: 'alt', label: 'Alt' },
      { id: 'win', label: 'Win' },
    ];
    // Split a stored "ctrl+shift+m" into its modifier set + main key.
    function parseHotkeyCombo(str) {
      const mods = new Set();
      let main = '';
      String(str || '').split('+').map((s) => s.trim().toLowerCase()).filter(Boolean).forEach((tok) => {
        if (tok === 'ctrl' || tok === 'control') mods.add('ctrl');
        else if (tok === 'shift') mods.add('shift');
        else if (tok === 'alt') mods.add('alt');
        else if (tok === 'win' || tok === 'meta' || tok === 'super' || tok === 'cmd') mods.add('win');
        else main = tok;
      });
      return { mods, main };
    }
    function hotkeyCaptureControl(step, name) {
      const wrap = document.createElement('div'); wrap.className = 'deck-ed-hotkey';
      const parsed = parseHotkeyCombo(step.params[name]);
      const mods = parsed.mods;
      let main = parsed.main;

      const preview = document.createElement('div'); preview.className = 'deck-ed-hotkey-preview';
      const commit = () => {
        const ordered = _HK_MODS.filter((m) => mods.has(m.id)).map((m) => m.id);
        const combo = main ? ordered.concat(main).join('+') : '';
        step.params[name] = combo;
        preview.textContent = combo || t('deck_hotkey_empty');
        preview.classList.toggle('is-empty', !combo);
      };

      // Modifier toggle chips — tapping never physically presses the key.
      const modRow = document.createElement('div'); modRow.className = 'deck-ed-hotkey-mods';
      _HK_MODS.forEach((m) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'deck-ed-hotkey-mod'; b.textContent = m.label;
        if (mods.has(m.id)) b.classList.add('active');
        b.addEventListener('click', () => {
          if (mods.has(m.id)) { mods.delete(m.id); b.classList.remove('active'); }
          else { mods.add(m.id); b.classList.add('active'); }
          commit();
        });
        modRow.appendChild(b);
      });

      // Main-key field — tap it and press a single key (letter, digit, F-key…). No
      // modifier is held here, so no OS shortcut can hijack the capture.
      const row = document.createElement('div'); row.className = 'deck-ed-hotkey-row';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'deck-ed-input deck-ed-hotkey-input'; inp.readOnly = true;
      inp.value = main;
      inp.placeholder = t('deck_hotkey_mainkey');
      inp.title = t('deck_hotkey_mainkey');
      inp.addEventListener('keydown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Backspace' || e.key === 'Delete') { main = ''; inp.value = ''; commit(); return; }
        const tok = hotkeyToken(e);
        if (!tok) return;   // modifier alone / unsupported key: ignore
        main = tok; inp.value = tok; commit();
      });
      const clear = document.createElement('button');
      clear.type = 'button'; clear.className = 'deck-ed-hotkey-clear'; clear.innerHTML = window.DeckIcons.CLOSE_MARK; clear.title = t('deck_hotkey_clear');
      clear.addEventListener('click', () => {
        mods.clear(); main = ''; inp.value = '';
        modRow.querySelectorAll('.deck-ed-hotkey-mod.active').forEach((x) => x.classList.remove('active'));
        commit();
      });
      row.append(inp, clear);

      wrap.append(modRow, row, preview);
      commit();
      return wrap;
    }

    return { hotkeyCaptureControl };
};
