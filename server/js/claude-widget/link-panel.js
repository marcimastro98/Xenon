// Connecting Claude Code from the tile: the button that says whether it is connected, and the panel
// that says what connecting writes before it does.
'use strict';

window.ClaudeWidgetLinkPanel = (wrapper) => {
  const { paint, doLink } = wrapper;

  const { t } = window.ClaudeWidgetWords;
  const { widgetState, live } = window.ClaudeWidgetKnown;
  const { el } = window.ClaudeWidgetLines;

  function linkButton() {
    const linked = !!(widgetState.linkState && widgetState.linkState.linked);
    const b = el('button', 'cw-linkbtn' + (linked ? ' is-on' : '')); b.type = 'button';
    b.textContent = linked ? t('claude_connected', 'Connected') : t('claude_connect', 'Connect Claude Code');
    b.addEventListener('click', () => { widgetState.linkPanel = true; paint(); });
    return b;
  }

  function linkPanelView() {
    const wrap = el('div', 'cw-panel');
    const head = el('div', 'cw-panel-head');
    head.appendChild(el('div', 'cw-panel-title', t('claude_link_title', 'Connect Claude Code')));
    const close = el('button', 'cw-panel-close'); close.type = 'button';
    close.setAttribute('aria-label', t('back', 'Back'));
    close.textContent = '✕';
    close.addEventListener('click', () => { widgetState.linkPanel = false; paint(); });
    head.appendChild(close);
    wrap.appendChild(head);

    const linked = !!(widgetState.linkState && widgetState.linkState.linked);
    wrap.appendChild(el('div', 'cw-panel-body', linked
      ? t('claude_link_on_desc', 'Claude Code reports its real quota, live session state and permission requests to this dashboard.')
      : t('claude_link_off_desc', 'Adds hooks and a status line to your Claude Code settings. Unlocks the real 5-hour and 7-day quota, exact session state, and approving permission requests from this screen.')));

    const notes = el('ul', 'cw-panel-notes');
    const note = (text) => { const li = el('li', 'cw-panel-note', text); notes.appendChild(li); };
    note(t('claude_link_note_backup', 'Your settings.json is backed up before the first change.'));
    if (widgetState.linkState && widgetState.linkState.chained) note(t('claude_link_note_chain', 'Your existing status line keeps running.'));
    note(t('claude_link_note_restart', 'Sessions already open need a restart to report.'));
    const mod = live() && live().mod;
    const modSetUp = !!(widgetState.linkState && widgetState.linkState.modEnabled);
    if (!linked) note(t('claude_link_note_mod', 'Also installs the Xenon mod for Claude Code.'));
    else if (mod) note(t('claude_mod_on', 'The Xenon mod is active in Claude Code.'));
    else if (modSetUp) note(t('claude_mod_pending', 'The mod is set up. It starts with your next Claude Code session.'));
    else note(t('claude_mod_hint', 'Not installed yet: adds subagent models, live context and approvals on this screen.'));
    wrap.appendChild(notes);

    const acts = el('div', 'cw-panel-acts');
    const go = el('button', 'cw-panel-go' + (linked ? ' is-off' : '')); go.type = 'button';
    go.disabled = widgetState.linking;
    go.textContent = widgetState.linking
      ? t('claude_working', 'Working…')
      : (linked ? t('claude_disconnect', 'Disconnect') : t('claude_connect_go', 'Connect'));
    go.addEventListener('click', () => doLink(!linked));
    acts.appendChild(go);
    // One tap for a link made before the mod existed: connecting again writes the
    // same hooks and adds the mod.
    if (linked && !mod && !modSetUp) {
      const add = el('button', 'cw-panel-go'); add.type = 'button';
      add.disabled = widgetState.linking;
      add.textContent = t('claude_mod_install', 'Install the mod');
      add.addEventListener('click', () => doLink(true));
      acts.appendChild(add);
    }
    wrap.appendChild(acts);

    if (widgetState.linkState && widgetState.linkState.settingsPath) wrap.appendChild(el('div', 'cw-panel-path', widgetState.linkState.settingsPath));
    return wrap;
  }

  return { linkButton, linkPanelView };
};
