// The Twitch tile's words and icons: tab labels, viewer counts, toggles, the chat error line and
// the way to Streaming settings.
'use strict';

(() => {
  const ICONS = {
    logo: '<svg viewBox="0 0 24 28" fill="#9146ff"><path d="M2.2 0L0 5.6v20.1h6.7V28h3.9l3.2-2.3h5.5L24 20.1V0zm2.2 2.2h17.4v16.8l-3.9 3.9h-5.5l-3.2 2.2v-2.2H4.4zm5.8 12.3h2.2V7.8h-2.2zm6 0h2.2V7.8h-2.2z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    fire: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.5 3.2-1.2 4.6-2.6 6C7.8 9.6 6 11.2 6 14a6 6 0 0 0 12 0c0-3-1.5-4.7-3-6.4-1-1.2-1.8-2.4-1.6-4C12.8 4.4 12.4 3 12 2zm0 11a2.6 2.6 0 0 1 2.6 2.6A2.6 2.6 0 0 1 12 18.2a2.6 2.6 0 0 1-2.6-2.6C9.4 14.2 12 14 12 13z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    viewers: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3L10.5 13.5"/><path d="M21 3l-6.8 18-3.7-7.5L3 9.8z"/></svg>',
    cinema: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/></svg>',
    fill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="6.5" y="8.5" width="11" height="7" rx="1" fill="currentColor" stroke="none"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-7l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5z"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
    smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/></svg>',
  };
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  const TAB_LABEL = {
    followed: () => t('tww_tab_followed', 'Followed'),
    top: () => t('tww_tab_top', 'Top'),
    search: () => t('tww_tab_search', 'Search'),
  };

  function fmtViewers(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '';
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(v);
  }

  // Open Settings → Streaming, the same way the Discord widget's "not linked"
  // notice does.
  function openStreamingSettings() {
    openSettingsCategory('streaming');
  }

  function showChatErr(msg) {
    document.querySelectorAll('.tww-chat-err').forEach(n => {
      n.textContent = msg;
      n.style.display = msg ? '' : 'none';
      clearTimeout(n._tm);
      if (msg) n._tm = setTimeout(() => { n.textContent = ''; n.style.display = 'none'; }, 8000);
    });
  }

  function setLabel(node, label) {
    if (node.title === label) return;
    node.title = label; node.setAttribute('aria-label', label);
  }

  function setToggle(node, on, disabled, label) {
    node.classList.toggle('is-on', on);
    node.setAttribute('aria-pressed', String(on));
    node.disabled = disabled;
    setLabel(node, label);
  }

  window.TwitchwatchWidgetLabels = {
    ICONS, t, TAB_LABEL, fmtViewers, openStreamingSettings, showChatErr, setLabel, setToggle,
  };
})();
