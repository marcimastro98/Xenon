// The YouTube tile's icons and words: the tab list and its labels, the time format, the line under
// a failed action, the toggles' labels and the way to Streaming settings.
'use strict';

(() => {
  const ICONS = {
    logo: '<svg viewBox="0 0 90 64" fill="none"><rect width="90" height="64" rx="18" fill="#ff0000"/><path d="M36 46V18l24 14z" fill="#0b0d10"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 6h2.2v12H7zM19 6v12l-8.5-6z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.8 6H17v12h-2.2zM5 6l8.5 6L5 18z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 8.5a4.5 4.5 0 0 1 0 7"/></svg>',
    muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    subs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M6 3h12"/><path d="M11 11l4 2.5-4 2.5z" fill="currentColor" stroke="none"/></svg>',
    cinema: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/></svg>',
    fill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="6.5" y="8.5" width="11" height="7" rx="1" fill="currentColor" stroke="none"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h11M4 12h11M4 17h7"/><path d="M18 11v8"/><path d="M18 11l3-1v8" fill="none"/></svg>',
  };
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl; // shared DOM factory from utils.js

  // One shared model for every tile: what tab is open, what it holds, and which
  // playlist (if any) the user has drilled into.
  const TABS = ['liked', 'playlists', 'subs', 'search'];
  const TAB_LABEL = {
    liked: () => t('youtube_liked', 'Liked'),
    playlists: () => t('youtube_playlists', 'Playlists'),
    subs: () => t('youtube_tab_subs', 'Subscriptions'),
    search: () => t('youtube_tab_search', 'Search'),
  };

  // Both cards are taken off screen when no account is connected, which used to
  // leave the tile as a logo on an empty background for as long as that stayed
  // true — unavailable is meant to be hidden OR explained, and that was neither.
  // The notice below is what remains, and it is the way in: tapping it lands on
  // the page where the account is connected.
  function openStreamingSettings() {
    openSettingsCategory('streaming');
  }

  function showActionErr(btn, reason) {
    const card = btn.closest('.yt-card');
    if (!card) return;
    let n = card.querySelector('.yt-err');
    if (!n) { n = el('div', 'yt-err'); card.appendChild(n); }
    n.textContent = t(reason === 'not_connected' ? 'youtube_err_not_connected' : 'youtube_err_generic', 'Action failed');
    n.style.display = '';
    clearTimeout(n._tm); n._tm = setTimeout(() => { n.style.display = 'none'; }, 6000);
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
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

  window.YoutubeWidgetLook = {
    ICONS, t, el, TABS, TAB_LABEL, openStreamingSettings, showActionErr, fmtTime, setLabel, setToggle,
  };
})();
