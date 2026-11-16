// The tile's header (the Claude Code mark, the quota, the faces, New session) and the one notice
// about the connection.
'use strict';

window.ClaudeWidgetTileHeader = (wrapper) => {
  const { paint, quotaMini, currentFace, setFace, ui, openAsk, linkButton, doLink } = wrapper;

  const { t } = window.ClaudeWidgetWords;
  const { widgetState } = window.ClaudeWidgetKnown;
  const { el } = window.ClaudeWidgetLines;

  const REPAIR_SEEN_KEY = 'xeneonedge.claude.repairSeen.v1';

  function header() {
    const h = el('div', 'cw-top');
    const title = el('div', 'cw-name');
    // The connection as a mark, not a sentence: complete, partly there, or off.
    const state = !widgetState.linkState ? 'unknown' : !widgetState.linkState.linked ? 'off' : widgetState.linkState.complete === false ? 'partial' : 'on';
    const brand = el('span', 'cw-brand');
    brand.appendChild(window.ClaudeClawd.make('cw-brand-mark'));
    title.appendChild(brand);
    title.setAttribute('aria-label', 'Claude Code');
    title.title = state === 'on' ? t('claude_connected', 'Connected')
      : state === 'partial' ? t('claude_link_incomplete', 'Part of the Claude Code connection is missing.')
        : t('claude_cta', 'Show real quota and approve from here');
    title.setAttribute('role', 'button');
    title.tabIndex = 0;
    const openLink = () => { widgetState.linkPanel = true; paint(); };
    title.addEventListener('click', openLink);
    title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openLink(); } });
    h.appendChild(title);

    const q = quotaMini();
    if (q) h.appendChild(q);

    const faces = el('div', 'cw-faces');
    faces.setAttribute('role', 'tablist');
    [['live', t('claude_sessions', 'Sessions')], ['usage', t('claude_face_usage', 'Usage')], ['history', t('claude_face_history', 'Chats')]].forEach(([id, label]) => {
      const b = el('button', 'cw-face' + (currentFace() === id ? ' is-on' : ''), label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', currentFace() === id ? 'true' : 'false');
      b.addEventListener('click', () => setFace(id));
      faces.appendChild(b);
    });
    h.appendChild(faces);

    if (widgetState.linkState && widgetState.linkState.linked) {
      const ask = el('button', 'cw-ask-open' + (ui.composing ? ' is-on' : '')); ask.type = 'button';
      ask.appendChild(el('span', 'cw-ask-open-plus', '+'));
      ask.appendChild(el('span', 'cw-ask-open-t', t('claude_new_session', 'New session')));
      ask.setAttribute('aria-label', t('claude_new_session', 'New session'));
      ask.addEventListener('click', () => openAsk('', '', ''));
      h.appendChild(ask);
    } else {
      h.appendChild(linkButton());
    }
    return h;
  }

  // What changed about the connection, said once where it matters. A repair
  // only reaches sessions started after it (Claude Code reads its hooks when a
  // session starts), so the notice says to restart the open ones.
  function linkNotice() {
    if (!widgetState.linkState || !widgetState.linkState.linked) return null;
    if (widgetState.linkState.complete === false) {
      const n = el('div', 'cw-notice is-warn');
      n.appendChild(el('span', 'cw-notice-t', t('claude_link_incomplete', 'Part of the Claude Code connection is missing.')));
      const b = el('button', 'cw-link-btn'); b.type = 'button';
      b.textContent = t('claude_link_repair', 'Repair');
      b.addEventListener('click', () => doLink(true));
      n.appendChild(b);
      return n;
    }
    let seen = 0;
    try { seen = Number(localStorage.getItem(REPAIR_SEEN_KEY)) || 0; } catch { /* private mode */ }
    if (widgetState.linkState.repairedAt && widgetState.linkState.repairedAt > seen) {
      const n = el('div', 'cw-notice');
      n.appendChild(el('span', 'cw-notice-t', t('claude_link_repaired', 'The Claude Code connection was updated. Restart the Claude Code sessions that are open to use it.')));
      const b = el('button', 'cw-link-btn'); b.type = 'button';
      b.textContent = t('claude_notice_ok', 'OK');
      b.addEventListener('click', () => {
        try { localStorage.setItem(REPAIR_SEEN_KEY, String(widgetState.linkState.repairedAt)); } catch { /* private mode */ }
        paint();
      });
      n.appendChild(b);
      return n;
    }
    return null;
  }

  return { header, linkNotice };
};
