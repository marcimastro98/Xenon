'use strict';
// Built-in monochrome icon library for the Deck. A curated set of 24×24 filled
// glyphs (Material-style path data) grouped into categories. Icons tint to the
// key's text colour via `fill: currentColor` in CSS, so they read as crisp
// vector caps at any size — unlike emoji, whose look varies per platform.
//
// Shared by deck.js (renders a key's chosen icon) and deck-editor.js (the icon
// picker grid). The id → path map is fully static/developer-authored: a key only
// ever stores an id, never markup, so building an element from a looked-up path
// is safe (no user data is ever interpreted as HTML).
(function () {
  // id -> SVG path "d" data (viewBox 0 0 24 24). Single-colour filled shapes.
  const PATHS = {
    // Media transport
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    stop: 'M6 6h12v12H6z',
    prev: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6h2v12h-2z',
    music: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3z',
    video: 'M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z',
    camera: 'M9 2 7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',

    // Audio + mic
    mic: 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z',
    micOff: 'M19 11h-1.7a5.34 5.34 0 0 1-.43 2.05l1.23 1.23A6.91 6.91 0 0 0 19 11zm-4.02.17V5a3 3 0 0 0-6 .18zM4.27 3 3 4.27l6 6V11a3 3 0 0 0 3.65 2.92l1.66 1.66A4.94 4.94 0 0 1 7 11H5a7 7 0 0 0 6 6.72V21h2v-3.28a6.84 6.84 0 0 0 2.54-.9L19.73 21 21 19.73z',
    volUp: 'M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z',
    volOff: 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45a4.6 4.6 0 0 0 .05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.9 8.9 0 0 0 3.69-1.81L19.73 21 21 19.73zM12 4 9.91 6.09 12 8.18z',
    headset: 'M12 1a9 9 0 0 0-9 9v7a3 3 0 0 0 3 3h3v-8H5v-2a7 7 0 0 1 14 0v2h-4v8h3a3 3 0 0 0 3-3v-7a9 9 0 0 0-9-9z',

    // Streaming
    record: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
    broadcast: 'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7.76 7.76 6.34 6.34a8 8 0 0 0 0 11.32l1.42-1.42a6 6 0 0 1 0-8.48zm9.9-1.42-1.42 1.42a6 6 0 0 1 0 8.48l1.42 1.42a8 8 0 0 0 0-11.32zM4.93 4.93 3.51 3.51a12 12 0 0 0 0 16.98l1.42-1.42a10 10 0 0 1 0-14.14zm15.56-1.42-1.42 1.42a10 10 0 0 1 0 14.14l1.42 1.42a12 12 0 0 0 0-16.98z',
    bolt: 'M7 2v11h3v9l7-12h-4l4-8z',

    // System
    settings: 'M19.14 12.94a7.5 7.5 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.49-.41h-3.84a.5.5 0 0 0-.49.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.74 8.87a.5.5 0 0 0 .12.61l2.03 1.58a7.5 7.5 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32c.14.24.42.31.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.06.24.25.41.49.41h3.84c.24 0 .44-.17.49-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.5.5 0 0 0-.12-.61zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z',
    power: 'M13 3h-2v10h2zm4.83 2.17-1.42 1.42a7 7 0 1 1-8.82 0L6.17 5.17a9 9 0 1 0 11.66 0z',
    lock: 'M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0z',
    computer: 'M20 18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2H0v2h24v-2zM4 6h16v10H4z',
    folder: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z',
    brightness: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM2 13h2a1 1 0 0 0 0-2H2a1 1 0 0 0 0 2zm18 0h2a1 1 0 0 0 0-2h-2a1 1 0 0 0 0 2zM11 2v2a1 1 0 0 0 2 0V2a1 1 0 0 0-2 0zm0 18v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0zM5.99 4.58a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41zm12.37 12.37a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41zm1.06-10.96a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41zM7.05 18.36a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41z',
    moon: 'M12 3a9 9 0 1 0 2.41 17.68A7 7 0 0 1 12.41 3.32 9 9 0 0 0 12 3z',
    wifi: 'M1 9l2 2a12.73 12.73 0 0 1 18 0l2-2A15.57 15.57 0 0 0 1 9zm8 8 3 3 3-3a4.24 4.24 0 0 0-6 0zm-4-4 2 2a7.07 7.07 0 0 1 10 0l2-2A9.9 9.9 0 0 0 5 13z',

    // Communication
    mail: 'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5z',
    chat: 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z',
    phone: 'M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02z',
    bell: 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5a6.03 6.03 0 0 0-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68A6.03 6.03 0 0 0 6 11v5l-2 2v1h16v-1z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 1 0 13.43 14l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',

    // Symbols
    star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3A5.5 5.5 0 0 1 12 5.09 5.5 5.5 0 0 1 16.5 3C19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z',
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
    gamepad: 'M21.58 16.09l-1.09-7.66A3.5 3.5 0 0 0 16.53 5H7.47a3.5 3.5 0 0 0-3.96 3.43l-1.09 7.66A2.55 2.55 0 0 0 4.94 19a2.5 2.5 0 0 0 1.8-.75L9 16h6l2.25 2.25a2.5 2.5 0 0 0 1.8.75 2.55 2.55 0 0 0 2.53-2.91zM11 11H9v2H8v-2H6v-1h2V8h1v2h2zm4-1a1 1 0 1 1 1-1 1 1 0 0 1-1 1zm2 3a1 1 0 1 1 1-1 1 1 0 0 1-1 1z',

    // Arrows
    arrowUp: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8z',
    arrowDown: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8z',
    arrowLeft: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z',
    arrowRight: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
    refresh: 'M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z',
  };

  // Ordered categories for the picker. labelKey is an i18n key (deck.js never
  // needs these — only the editor groups by category).
  const CATEGORIES = [
    { key: 'media', labelKey: 'deck_cat_media', ids: ['play', 'pause', 'stop', 'prev', 'next', 'music', 'video', 'camera'] },
    { key: 'audio', labelKey: 'deck_cat_audio', ids: ['mic', 'micOff', 'volUp', 'volOff', 'headset'] },
    { key: 'stream', labelKey: 'deck_cat_stream', ids: ['record', 'broadcast', 'video', 'camera', 'bolt'] },
    { key: 'system', labelKey: 'deck_cat_system', ids: ['settings', 'power', 'lock', 'computer', 'folder', 'brightness', 'moon', 'wifi'] },
    { key: 'comm', labelKey: 'deck_cat_comm', ids: ['mail', 'chat', 'phone', 'bell', 'search'] },
    { key: 'symbol', labelKey: 'deck_cat_symbol', ids: ['star', 'heart', 'home', 'check', 'close', 'add', 'gamepad'] },
    { key: 'arrow', labelKey: 'deck_cat_arrow', ids: ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight', 'refresh'] },
  ];

  function has(id) { return Object.prototype.hasOwnProperty.call(PATHS, id); }

  // Build an <svg> element for a known id, or null. The path string is a fixed
  // library constant (never a stored/user value), so this introduces no markup
  // injection — the element is assembled via the SVG DOM API regardless.
  function el(id) {
    if (!has(id)) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', PATHS[id]);
    svg.appendChild(path);
    return svg;
  }

  if (typeof window !== 'undefined') {
    window.DeckIcons = { CATEGORIES, has, el, ids: () => Object.keys(PATHS) };
  }
})();
