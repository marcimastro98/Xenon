// The pieces the remote-control setup is built from: a section, a button, a row of keys, a status
// line, the frame of a step, the introduction, and the pass that puts the words of the chosen
// language in them.

(() => {
  'use strict';

  const { platformKey } = window.RemoteControlStatus;

  function el(tag, className, key) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (key) node.setAttribute('data-i18n', key);
    return node;
  }

  function section(titleKey) {
    const box = el('section', 'settings-section');
    box.appendChild(el('div', 'settings-section-title', titleKey));
    return box;
  }

  function button(className, key, onClick) {
    const btn = el('button', className, key);
    btn.type = 'button';
    btn.addEventListener('click', () => onClick(btn));
    return btn;
  }

  function keyRow(...keys) {
    const row = el('div', 'settings-row settings-row-keys');
    row.append(...keys);
    return row;
  }

  function statusLine() {
    const line = el('div', 'remote-status');
    line.hidden = true;
    return line;
  }

  function buildIntro() {
    const box = section('remote.intro_title');
    // Where the software comes from, named honestly per platform. Telling a
    // Linux user their packages arrive "via winget, Microsoft's official
    // package manager" is worse than saying nothing: it describes a machine
    // they are not sitting at.
    for (const key of ['remote.intro_p1', platformKey('remote.intro_p2'), 'remote.intro_p3']) {
      box.appendChild(el('p', 'settings-note', key));
    }
    return box;
  }

  function buildStepShell(num, titleKey, done, current) {
    const step = el('div', 'settings-step' + (done ? ' done' : '') + (current ? ' current' : ''));
    const head = el('div', 'settings-step-head');
    const numEl = el('span', 'settings-step-num');
    numEl.textContent = done ? '✓' : num;
    head.append(numEl, el('span', 'settings-step-title', titleKey));
    step.append(head, el('div', 'settings-step-body'));
    return step;
  }

  // Runs ONLY on our injected subtree to avoid triggering a settings-modal
  // re-render (which would call renderSettingsModal → syncSettingsControls →
  // RemoteControl.init → here, causing an infinite cycle).
  function localizeSubtree(root) {
    if (!root || typeof t !== 'function') return;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
  }

  window.RemoteControlPagePieces = {
    el, section, button, keyRow, statusLine, buildIntro, buildStepShell, localizeSubtree,
  };
})();
