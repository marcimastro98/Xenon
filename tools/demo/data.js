'use strict';
// Canned content for the static browser demo (docs/demo, built by
// tools/build-demo.mjs). Pure data — no DOM, no timers, no fetch. The moving
// parts live in demo/boot.js.
//
// Treat this file the way you would treat a marketing screenshot, because that
// is what it is: it is the first Xenon most visitors will ever see.
//
// Deliberately NOT seeded here: `dashboardLayout`. The app's own factory default
// (normalizeDashboardLayout(null) in settings.js) is a well-composed first-run
// arrangement, and every tile it opens with is mocked below — so hand-writing a
// layout would only add a private schema this file would then have to track.
window.__XD__ = (function () {
  const HOUR = 3600 * 1000;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const dayAt = (offsetDays, h, m) => {
    const d = new Date(now + offsetDays * 24 * HOUR);
    d.setHours(h, m || 0, 0, 0);
    return d.getTime();
  };

  // Track covers are inline SVG data URIs: no third-party art, no licensing
  // question, and no bytes on the wire.
  const cover = (a, b, glyph) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="' + a + '"/><stop offset="1" stop-color="' + b + '"/>' +
    '</linearGradient></defs><rect width="300" height="300" fill="url(#g)"/>' +
    '<text x="150" y="196" font-family="Inter,sans-serif" font-size="140" font-weight="800" ' +
    'text-anchor="middle" fill="rgba(255,255,255,0.82)">' + glyph + '</text></svg>');

  return {
    // Seeded into localStorage['xeneonedge.settings.v1'] on first visit. Only
    // well-known top-level keys — anything the app does not recognise is dropped
    // by normalizeSettings() anyway.
    settings: {
      language: 'en',
      appearance: 'dark',
      accent: '#1ed760',
      weather: { city: 'Milano', unit: 'c' },
      clockSeconds: true,
      // The demo must never nag a visitor about updating an install they don't
      // have, and must never start the wake-word/voice paths.
      updateCheck: false,
      wakeWord: false,
    },

    system: {
      hostname: 'XENON-DEMO',
      cpuName: 'AMD Ryzen 7 7800X3D 8-Core Processor',
      gpuName: 'NVIDIA GeForce RTX 5080',
      ramDetail: { detail: '32 GB DDR5-6000', moduleName: 'Corsair Dominator Titanium' },
      vramTotal: 16 * 1024 * 1024 * 1024,
      memoryTotal: 32 * 1024 * 1024 * 1024,
      disks: [
        { drive: 'C:', label: 'System', fileSystem: 'NTFS', driveType: 'SSD', total: 2000398934016, used: 1174405120000 },
        { drive: 'D:', label: 'Games', fileSystem: 'NTFS', driveType: 'SSD', total: 4000797868032, used: 2915166912512 },
      ],
      fans: [
        { name: 'CPU Fan', rpm: 980 }, { name: 'Front 1', rpm: 720 },
        { name: 'Front 2', rpm: 715 }, { name: 'Rear', rpm: 840 },
      ],
    },

    playlist: [
      { title: 'Midnight Protocol', artist: 'VECTOR SEVEN', album: 'Dead End Streets', duration: 254, thumbnail: cover('#1ed760', '#0b6b39', '◈') },
      { title: 'Neon Districts', artist: 'Dan Terminus', album: 'The Wrath of Code', duration: 331, thumbnail: cover('#7b5cff', '#2b1a6b', '◆') },
      { title: 'Slow Burn', artist: 'Carpenter Brut', album: 'Leather Terror', duration: 218, thumbnail: cover('#ff5470', '#6b1226', '▲') },
      { title: 'Aurora Drift', artist: 'Perturbator', album: 'Lustful Sacraments', duration: 287, thumbnail: cover('#3ec9ff', '#0d3a6b', '●') },
    ],

    audio: {
      speaker: { name: 'Corsair VIRTUOSO MAX', label: 'Headset Earphone', volume: 42, muted: false },
      mic: { name: 'Shure MV7', label: 'Microphone', volume: 78, muted: false },
      speakerApps: [
        { id: 'a1', proc: 'Spotify.exe', name: 'Spotify', volume: 100, muted: false },
        { id: 'a2', proc: 'Discord.exe', name: 'Discord', volume: 74, muted: false },
        { id: 'a3', proc: 'chrome.exe', name: 'Chrome', volume: 55, muted: true },
      ],
      micApps: [],
    },

    notes: {
      rev: 1, v: 1, activeId: 'n1',
      notes: [
        { id: 'n1', title: 'Welcome', text: 'This is a live demo of Xenon.\n\nEverything you see is simulated — the CPU load, the music, the weather. Nothing here touches a real PC.\n\nTry it: change the theme, drag the tiles around, open the Store and import a community theme. It all works.', updatedAt: iso(now - 2 * HOUR) },
        { id: 'n2', title: 'Shopping', text: '- coffee\n- thermal paste\n- a second monitor (apparently)', updatedAt: iso(now - 26 * HOUR) },
        { id: 'n3', title: 'Stream rundown', text: '1. intro + music\n2. build showcase\n3. Q&A\n4. outro', updatedAt: iso(now - 3 * 24 * HOUR) },
      ],
    },

    tasks: [
      { id: 't1', text: 'Rearrange the dashboard', done: false, priority: 'normal', createdAt: iso(now - 5 * HOUR) },
      { id: 't2', text: 'Try a community theme', done: false, priority: 'high', createdAt: iso(now - 8 * HOUR) },
      { id: 't3', text: 'Drink some water', done: true, priority: 'normal', createdAt: iso(now - 30 * HOUR) },
    ],

    // `startsAt` — NOT `start`. That is the field the calendar sorts and filters
    // the upcoming list on, and getting it wrong is silent: the events load, the
    // month grid fills, and "Upcoming" simply stays empty.
    events: [
      { id: 'e1', title: 'Stand-up', startsAt: iso(dayAt(0, 9, 30)) },
      { id: 'e2', title: 'Design review', startsAt: iso(dayAt(0, 15, 0)) },
      { id: 'e3', title: 'Stream night', startsAt: iso(dayAt(1, 21, 0)) },
      { id: 'e4', title: 'Parts delivery', startsAt: iso(dayAt(2, 10, 0)) },
      { id: 'e5', title: 'Coffee with Marco', startsAt: iso(dayAt(3, 16, 30)) },
    ],

    timers: [{ id: 'tm1', label: 'Focus', total: 1500, remaining: 1140, running: true }],

    // The client reads tempC/feelsC/condition/location and gates on `ok`.
    weather: {
      ok: true, stale: false, location: 'Milano',
      tempC: 21, feelsC: 20, condition: 'Partly cloudy',
    },

    // downloadBps/uploadBps, not down/up — the tiles read bytes per second.
    network: { downloadBps: 1_450_000, uploadBps: 210_000, ping: 12, latency: 9, fps: 0 },

    stocks: [
      { symbol: 'NVDA', name: 'NVIDIA', price: 184.22, changePct: 1.84 },
      { symbol: 'AAPL', name: 'Apple', price: 243.10, changePct: -0.42 },
      { symbol: 'CRSR', name: 'Corsair', price: 9.86, changePct: 2.31 },
    ],

    news: [
      { title: 'A 14.5-inch touchscreen is quietly becoming a PC accessory category', source: 'The Verge', url: '', publishedAt: iso(now - 2 * HOUR) },
      { title: 'Open-source dashboards are having a moment', source: 'Ars Technica', url: '', publishedAt: iso(now - 5 * HOUR) },
      { title: 'How much of your desk should be a screen?', source: 'Tom’s Hardware', url: '', publishedAt: iso(now - 9 * HOUR) },
    ],

    football: [
      { home: 'Inter', away: 'Milan', homeScore: 1, awayScore: 1, minute: 67, status: 'live', competition: 'Serie A' },
      { home: 'Napoli', away: 'Roma', homeScore: 0, awayScore: 0, minute: 0, status: 'scheduled', competition: 'Serie A' },
    ],

    battery: {
      devices: [
        { name: 'VIRTUOSO MAX', level: 68, charging: false },
        { name: 'K100 AIR', level: 92, charging: true },
        { name: 'DARK CORE PRO', level: 41, charging: false },
      ],
    },

    discord: { connected: true, voice: { channel: 'General', mute: false, deaf: false, inputVolume: 88, outputVolume: 100 } },

    wavelink: { connected: false },

    claude: { connected: false },

    homeassistant: {
      connected: true,
      lights: [
        { id: 'light.desk', name: 'Desk', on: true, brightness: 180 },
        { id: 'light.strip', name: 'Wall strip', on: true, brightness: 96 },
        { id: 'light.ceiling', name: 'Ceiling', on: false, brightness: 0 },
      ],
    },
  };
})();
