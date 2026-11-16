// The Spotify tile's icons and words: device icons, the tab list and its labels, time as m:ss, and
// the way to Spotify settings.
'use strict';

(() => {
  const ICONS = {
    // Official Spotify glyph (solid) — crisp at any size, unlike a hand-traced path.
    logo: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.42 1.56-.299.421-1.02.599-1.559.3z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5l9 7-9 7zM16 5h2.4v14H16z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 5l-9 7 9 7zM5.6 5H8v14H5.6z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.3 4.2 12.5a4.4 4.4 0 0 1 6.2-6.2l1.6 1.6 1.6-1.6a4.4 4.4 0 0 1 6.2 6.2z"/></svg>',
    heartFilled: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5 4.05 12.6a4.5 4.5 0 0 1 6.36-6.37L12 7.8l1.59-1.57a4.5 4.5 0 0 1 6.36 6.37z"/></svg>',
    volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h3l6 4V5L7 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    play_s: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="3"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/></svg>',
  };

  // A device's icon by its Spotify type (falls back to a generic speaker).
  function deviceIcon(type) {
    if (type === 'computer') return ICONS.computer;
    if (type === 'smartphone' || type === 'tablet') return ICONS.phone;
    return ICONS.speaker;
  }

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;   // shared DOM factory from utils.js

  const TABS = [
    { id: 'queue', labelKey: 'spotify_w_upnext', fb: 'Up Next' },
    { id: 'playlists', labelKey: 'spotify_w_playlists', fb: 'Playlists' },
    { id: 'devices', labelKey: 'spotify_w_devices', fb: 'Devices' },
  ];

  function openSpotifySettings() {
    openSettingsCategory('spotify');
  }

  // mm:ss for a millisecond duration (— when unknown).
  function fmt(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // Re-apply every static (language-dependent) label so the widget follows the UI
  // language like every other panel (paint runs on a language change).
  function applyLabels(mount) {
    mount.querySelectorAll('.sp-tab').forEach(tb => {
      const def = TABS.find(x => x.id === tb.dataset.stab);
      if (def) tb.textContent = t(def.labelKey, def.fb);
    });
    const nTxt = mount.querySelector('.sp-notice-txt');
    if (nTxt) nTxt.textContent = t('spotify_w_connect', 'Connect in Settings → Spotify');
    const eLbl = mount.querySelector('.sp-now-empty-lbl');
    if (eLbl) eLbl.textContent = t('spotify_w_nothing', 'Nothing playing right now');
  }

  window.SpotifyWidgetLook = {
    ICONS, deviceIcon, t, el, TABS, openSpotifySettings, fmt, applyLabels,
  };
})();
