// The "/" picker under the composer: the commands and skills of a project or of a live session, the
// matches for what is typed, and the keys that move through the list.
'use strict';

window.ClaudeWidgetSlashPicker = (wrapper) => {
  const { api, paint, argMatches } = wrapper;

  const { t } = window.ClaudeWidgetWords;
  const { widgetState, sessionById, inLiveSession, canRunCommands } = window.ClaudeWidgetKnown;
  const { el } = window.ClaudeWidgetLines;
  const { runBuiltins, slashQuery } = window.ClaudeWidgetComposerParts;
  const { ui } = window.ClaudeWidgetConsoleState;

  // ── the "/" picker ─────────────────────────────────────────────────────────
  // Typing "/" at the start of a new or resumed run lists the user's commands
  // and skills (names only, from /api/claude/commands). Picking one writes
  // "/name " into the box and Claude Code expands it when the run starts. Not
  // offered for a message queued into a live session: that text is handed to
  // the session as a reply, where a slash command would not run.
  const MAX_PICKS = 6;
  const commandLists = new Map();   // project id → [{ name, desc, kind }] | 'loading'

  function commandsFor(projectId) {
    const key = projectId || '';
    const got = commandLists.get(key);
    if (Array.isArray(got)) return got;
    if (got !== 'loading') {
      commandLists.set(key, 'loading');
      api('/api/claude/commands?project=' + encodeURIComponent(key)).then((d) => {
        commandLists.set(key, d && Array.isArray(d.commands) ? d.commands : []);
        paint();
      });
    }
    return null;
  }

  // The open session's own list (what its terminal's "/" shows), once its mod
  // has reported it; the three header commands before that.
  const liveCommandLists = new Map();   // session id → { at, list } | 'loading'
  function liveCommands(s) {
    if (!s || !s.commandsAt) return null;
    const got = liveCommandLists.get(s.id);
    if (got && got !== 'loading' && got.at === s.commandsAt) return got.list;
    if (got !== 'loading') {
      liveCommandLists.set(s.id, 'loading');
      api('/api/claude/session-commands?session=' + encodeURIComponent(s.id)).then((d) => {
        const list = d && Array.isArray(d.commands) ? d.commands.map((c) => ({ name: c.name, desc: c.desc })) : null;
        // A failed read is remembered for this list version too, so the next paint
        // does not ask again at once; the header commands stand in meanwhile.
        liveCommandLists.set(s.id, { at: s.commandsAt, list });
        paint();
      });
    }
    return got && got !== 'loading' ? got.list : null;
  }

  function tileCommandList() {
    const own = liveCommands(sessionById(widgetState.askResumeId));
    if (own) return own;
    return [
      { name: 'model', desc: t('claude_slash_model', 'Change the model, e.g. /model opus') },
      { name: 'effort', desc: t('claude_slash_effort', 'Set the effort: low, medium, high, xhigh, max') },
      { name: 'compact', desc: t('claude_slash_compact', 'Summarise the conversation to free up context') },
    ];
  }

  function slashMatches(text) {
    const args = argMatches(text);
    if (args) return inLiveSession() && !canRunCommands() ? [] : args;
    const q = slashQuery(text);
    if (q === null) return null;
    if (inLiveSession() && !canRunCommands()) return [];   // drawPicker says why
    const own = inLiveSession() ? tileCommandList() : commandsFor(widgetState.askProjectId);
    if (!own) return [];
    const list = inLiveSession() ? own : runBuiltins().filter((b) => !own.some((c) => c.name === b.name)).concat(own);
    // Names that start with the word first, then names that contain it.
    const starts = list.filter((c) => c.name.toLowerCase().startsWith(q));
    const contains = list.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    return starts.concat(contains).slice(0, MAX_PICKS);
  }

  function drawPicker(picker, ta) {
    picker.textContent = '';
    const list = slashMatches(ta.value);
    picker.hidden = !list;
    if (!list) return;
    if (!list.length) {
      if (inLiveSession() && !canRunCommands()) {
        picker.appendChild(el('div', 'cw-slash-empty', t('claude_cmd_modold', 'The Xenon mod in that terminal is older than 0.4.0. Update it and restart Claude Code to run commands from here.')));
        return;
      }
      picker.appendChild(el('div', 'cw-slash-empty', commandLists.get(widgetState.askProjectId || '') === 'loading'
        ? t('claude_slash_loading', 'Reading your commands…') : t('claude_slash_none', 'No command or skill with that name')));
      return;
    }
    ui.pickAt = Math.min(ui.pickAt, list.length - 1);
    list.forEach((c, i) => {
      const row = el('button', 'cw-slash-item' + (i === ui.pickAt ? ' is-on' : '')); row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === ui.pickAt ? 'true' : 'false');
      // The command's own name first, its plugin after it and quieter: a long
      // "plugin:command" cut short would otherwise lose the part that matters.
      // Picking still inserts the full name.
      const cut = c.isArg ? -1 : c.name.lastIndexOf(':');
      row.appendChild(el('span', 'cw-slash-name', c.isArg ? c.name : '/' + (cut > 0 ? c.name.slice(cut + 1) : c.name)));
      if (cut > 0) row.appendChild(el('span', 'cw-slash-ns', c.name.slice(0, cut)));
      if (c.desc) row.appendChild(el('span', 'cw-slash-desc', c.desc));
      // mousedown, not click: the textarea must keep focus for the next keys.
      row.addEventListener('mousedown', (e) => { e.preventDefault(); applyPick(c, picker, ta); });
      picker.appendChild(row);
    });
  }

  function applyPick(c, picker, ta) {
    ta.value = c.insert || '/' + c.name + ' ';
    widgetState.askText = ta.value;
    ui.pickAt = 0;
    drawPicker(picker, ta);
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
  }

  // Arrow keys move, Tab or Enter picks, Escape closes. True when handled.
  function pickerKey(e, picker, ta) {
    if (picker.hidden) return false;
    const list = slashMatches(ta.value) || [];
    if (!list.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      ui.pickAt = (ui.pickAt + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      drawPicker(picker, ta);
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
      applyPick(list[ui.pickAt], picker, ta);
      return true;
    }
    if (e.key === 'Escape') { picker.hidden = true; return true; }
    return false;
  }

  return { MAX_PICKS, drawPicker, pickerKey, tileCommandList };
};
