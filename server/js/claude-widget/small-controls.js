// Three small controls of the Claude tile: the head of a section that folds, the key that hides the
// side panel, and the quota in the header.
'use strict';

window.ClaudeWidgetSmallControls = (wrapper) => {
  const { toggleCollapsed, setFace } = wrapper;

  const { t } = window.ClaudeWidgetWords;
  const { clamp, level } = window.ClaudeWidgetModelWords;
  const { limits, isCollapsed } = window.ClaudeWidgetKnown;
  const { el } = window.ClaudeWidgetLines;

  // A section head that opens and closes. A real <button> so it is reachable by
  // keyboard and announced as a control, with the chevron carrying the state.
  function collapsibleTitle(key, text, hint) {
    const open = !isCollapsed(key);
    const b = el('button', 'cw-section cw-section-btn'); b.type = 'button';
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    const chev = el('span', 'cw-section-chev' + (open ? ' is-open' : ''));
    chev.textContent = '›';                 // › rotated by CSS when open
    b.appendChild(chev);
    b.appendChild(el('span', 'cw-section-t', text));
    if (hint) b.appendChild(el('span', 'cw-section-hint', hint));
    b.addEventListener('click', () => toggleCollapsed(key));
    return b;
  }

  // Hiding only: once hidden, the panel folds into its summary strip (asideStrip).
  function asideHide() {
    const b = el('button', 'cw-aside-hide', '›'); b.type = 'button';
    const label = t('claude_aside_hide', 'Hide the side panel');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-expanded', 'true');
    b.addEventListener('click', () => toggleCollapsed('aside'));
    return b;
  }

  // The quota, small enough to live in the header: two bars, the number, and
  // the full instruments one tap away on the Usage face.
  function quotaMini() {
    const lim = limits();
    if (!lim || !(lim.fiveHour || lim.sevenDay)) return null;
    const box = el('button', 'cw-qmini'); box.type = 'button';
    box.title = t('claude_quota', 'Quota');
    const now = Date.now();
    [['fiveHour', t('claude_5h', '5h')], ['sevenDay', t('claude_7d', '7d')]].forEach(([k, label]) => {
      const win = lim[k];
      if (!win) return;
      const renewed = win.resetsAt && win.resetsAt * 1000 <= now;
      const used = renewed ? 0 : clamp(Number(win.pct) || 0, 0, 100);
      const q = el('span', 'cw-qm is-' + level(used));
      q.appendChild(el('span', 'cw-qm-k', label));
      const bar = el('span', 'cw-qm-bar');
      const fill = el('span', 'cw-qm-fill'); fill.style.width = Math.round(used) + '%';
      bar.appendChild(fill);
      q.appendChild(bar);
      q.appendChild(el('span', 'cw-qm-v', Math.round(used) + '%'));
      box.appendChild(q);
    });
    box.addEventListener('click', () => setFace('usage'));
    return box;
  }

  return { collapsibleTitle, asideHide, quotaMini };
};
