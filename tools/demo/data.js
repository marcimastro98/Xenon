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

    // The Calcio tile's real payload shape — one entry per followed team or
    // competition, each carrying its own fixtures and results, plus the identity
    // map the crests, colours and grounds come from.
    //
    // No club badges: a crest is a trademark, and this file ships to a public
    // site. The tile's own fallback (initials on the club's colour) is a state
    // it really renders, so the demo shows something true rather than borrowed
    // artwork. Names, grounds, capacities and founding years are facts.
    football: (() => {
      const ev = (id, home, homeId, away, awayId, ms, over) => ({
        id, home, away, homeId, awayId, homeBadge: '', awayBadge: '',
        homeScore: null, awayScore: null, ts: iso(ms), date: '', time: '',
        league: 'Italian Serie A', leagueId: '4332', leagueBadge: '', round: '3',
        venue: '', status: 'ns', statusRaw: 'NS', season: '2026-2027', ...over,
      });
      const derby = ev('d1', 'Inter', '133681', 'Milan', '133670x', now - 67 * 60 * 1000,
        { homeScore: 1, awayScore: 1, status: 'live', progress: "67'", venue: 'San Siro' });
      const napoliNext = ev('n1', 'Napoli', '133670', 'Roma', '133682', dayAt(0, 20, 45),
        { venue: 'Stadio Diego Armando Maradona' });
      const romaNext = ev('r1', 'Lazio', '133683', 'Roma', '133682', dayAt(1, 18, 0), { venue: 'Stadio Olimpico' });
      const napoliLast = ev('n0', 'Napoli', '133670', 'Como', '133684', dayAt(-4, 18, 30),
        { homeScore: 2, awayScore: 0, status: 'ft', statusRaw: 'FT', round: '2', venue: 'Stadio Diego Armando Maradona' });
      const interLast = ev('i0', 'Udinese', '133685', 'Inter', '133681', dayAt(-5, 20, 45),
        { homeScore: 1, awayScore: 3, status: 'ft', statusRaw: 'FT', round: '2' });

      const team = (id, name, next, last, extraNext) => ({
        id, type: 'team', name, badge: '', leagueId: '4332', league: 'Italian Serie A',
        season: '2026-2027', next, last,
        nextList: [next].concat(extraNext || []).filter(Boolean), lastList: last ? [last] : [],
      });

      return {
        live: true,
        tile: { results: true, standings: true },
        teams: [
          team('133670', 'Napoli', napoliNext, napoliLast),
          team('133681', 'Inter', derby, interLast),
          team('133682', 'Roma', romaNext, null),
          { id: '4332', type: 'league', name: 'Italian Serie A', badge: '', leagueId: '4332',
            league: 'Italian Serie A', season: '2026-2027', next: napoliNext, last: napoliLast,
            nextList: [derby, napoliNext, romaNext], lastList: [napoliLast, interLast] },
        ],
        favorites: [
          { id: '133670', name: 'Napoli', league: 'Italian Serie A', leagueId: '4332' },
          { id: '133681', name: 'Inter', league: 'Italian Serie A', leagueId: '4332' },
          { id: '133682', name: 'Roma', league: 'Italian Serie A', leagueId: '4332' },
          { id: '4332', type: 'league', name: 'Italian Serie A' },
        ],
        info: {
          133670: { name: 'Napoli', colour: '#12a0d7', stadium: 'Stadio Diego Armando Maradona', capacity: 60240, founded: 1926, league: 'Italian Serie A', leagueId: '4332', desc: '' },
          133681: { name: 'Inter', colour: '#0069aa', stadium: 'San Siro', capacity: 80018, founded: 1908, league: 'Italian Serie A', leagueId: '4332', desc: '' },
          133682: { name: 'Roma', colour: '#8e1f2f', stadium: 'Stadio Olimpico', capacity: 70634, founded: 1927, league: 'Italian Serie A', leagueId: '4332', desc: '' },
        },
        standings: {
          leagueId: '4332', league: 'Italian Serie A', season: '2026-2027',
          rows: [
            { rank: 1, teamId: '133681', team: 'Inter', badge: '', played: 3, win: 2, draw: 1, loss: 0, gf: 7, ga: 3, gd: 4, points: 7, form: 'WWD' },
            { rank: 2, teamId: '133670', team: 'Napoli', badge: '', played: 3, win: 2, draw: 0, loss: 1, gf: 5, ga: 2, gd: 3, points: 6, form: 'WLW' },
            { rank: 3, teamId: '133682', team: 'Roma', badge: '', played: 3, win: 1, draw: 2, loss: 0, gf: 4, ga: 2, gd: 2, points: 5, form: 'DWD' },
            { rank: 4, teamId: '133683', team: 'Lazio', badge: '', played: 3, win: 1, draw: 1, loss: 1, gf: 3, ga: 3, gd: 0, points: 4, form: 'LWD' },
            { rank: 5, teamId: '133685', team: 'Udinese', badge: '', played: 3, win: 1, draw: 0, loss: 2, gf: 3, ga: 6, gd: -3, points: 3, form: 'LLW' },
          ],
        },
        news: [
          { id: 'f1', title: 'Serie A returns: what changed over the summer', url: '', source: 'Sky Sport', published: now - 40 * 60 * 1000, image: '' },
          { id: 'f2', title: 'Derby ends level after a second-half turnaround', url: '', source: 'Gazzetta', published: now - 3 * HOUR, image: '' },
          { id: 'f3', title: 'Napoli confirm the squad for the opening fixtures', url: '', source: 'Corriere dello Sport', published: now - 7 * HOUR, image: '' },
        ],
      };
    })(),

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
