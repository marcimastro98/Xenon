// Invented state for the music, video and streaming tiles. Every name is made up,
// in the demo's voice ("Midnight Protocol", "VECTOR SEVEN").

import { cover, dataUri, frame, landscape, portrait, skyline } from './art.mjs';

const MIN = 60 * 1000;

export const spotify = () => {
  const up = (name, artist, from, to, glyph) => ({ name, artist, uri: `spotify:track:${name.replace(/\W/g, '')}`, image: dataUri(cover({ from, to, glyph, w: 96 })) });
  return {
    answers: {
      '/stream/spotify/status': { connected: true, login: 'vectorseven' },
      '/stream/spotify/player': {
        ok: true, playing: true, shuffle: true, repeat: 'context', liked: true, supportsVolume: true, volume: 64, device: 'Desk speakers',
        progressMs: 94000, durationMs: 228000,
        track: { name: 'Glass Horizon', artist: 'Midnight Protocol', album: 'Low Orbit', image: dataUri(cover({ from: '#ff5f6d', to: '#5b2a86', glyph: '◈' })), uri: 'spotify:track:glasshorizon', id: 'glasshorizon' },
      },
      '/stream/spotify/queue': {
        ok: true, reliable: true, contextUri: 'spotify:playlist:night-drive',
        queue: [
          up('Neon Tide', 'VECTOR SEVEN', '#25c6da', '#123f8c', '◐'),
          up('Paper Satellites', 'Hollow Coast', '#f6c14b', '#c2542d', '✦'),
          up('Slow Static', 'Midnight Protocol', '#7c5cff', '#20134f', '◆'),
          up('Last Train North', 'The Quiet Hours', '#57d68d', '#0f5c56', '▲'),
          up('Harbour Lights', 'Timber & Tide', '#ff8fb1', '#7a1f5c', '✧'),
        ],
      },
      '/stream/spotify/playlists': { ok: true, playlists: [] },
      '/stream/spotify/devices': { ok: true, devices: [{ id: 'd1', name: 'Desk speakers', type: 'Computer', active: true }] },
    },
  };
};

export const youtube = () => {
  const video = (id, title, channel, seconds, image) => ({ id, title, channel, seconds, image: dataUri(image) });
  const videos = [
    video('nightwalk01', 'Night walk through the old harbour', 'Slow City', 2710, skyline({ seed: 5, w: 320, h: 180 })),
    video('cabinbuild1', 'Building a tiny cabin by the lake, start to finish', 'Timber & Tide', 1124, landscape({ seed: 11, w: 320, h: 180 })),
    video('watchworks1', 'How a mechanical watch really works', 'Small Gears', 846, landscape({ seed: 23, top: '#183a4a', bottom: '#7bd0c1', sun: '#fff1b8', hills: ['#2c6e6a', '#1e4f54', '#123238'], w: 320, h: 180 })),
    video('noodlepan01', 'Three weeknight noodles in one pan', 'Pan & Pantry', 512, landscape({ seed: 31, top: '#5b1f2e', bottom: '#f2b45c', sun: '#ffe9c2', hills: ['#a8452f', '#6d2a26', '#3a1a1f'], w: 320, h: 180 })),
    video('cavescan001', 'Mapping a cave with a home-made scanner', 'Deep Field', 1385, skyline({ seed: 9, top: '#0b1a2b', bottom: '#1f6a8c', glow: '#49e0c8', lit: '#9ff5e4', w: 320, h: 180 })),
  ];
  const still = frame(skyline({ seed: 5, w: 1280, h: 720 }));
  const playlists = [
    { id: 'plbuilds', title: 'Weekend builds', count: 24, image: videos[1].image },
    { id: 'plkitchen', title: 'Cooking at home', count: 12, image: videos[3].image },
    { id: 'plnight', title: 'Late night walks', count: 37, image: videos[0].image },
  ];
  return {
    answers: {
      '/stream/youtube/status': { connected: true, configured: true },
      '/stream/youtube/liked': { ok: true, videos },
      '/stream/youtube/playlists': { ok: true, playlists },
      '/stream/youtube/playlist/items': { ok: true, videos: videos.slice(1, 4) },
      '/stream/youtube/subscriptions': { ok: true, videos },
    },
    frames: { 'www.youtube-nocookie.com': still, 'www.youtube.com': still },
    stage: 'document.querySelector(".yt-row")?.click()',
  };
};

export const youtubelive = () => {
  const say = (id, author, text, wall, skin, hair, role = {}) => ({ id, author, text, avatar: dataUri(portrait({ wall, skin, hair, w: 64, h: 64 })), ...role });
  return {
    answers: {
      '/stream/youtube/status': { connected: true, configured: true },
      '/stream/youtube/broadcast': { ok: true, live: true, id: 'b1', title: 'Friday build night: finishing the cabin roof', viewers: 1284, totalViews: 18420, likes: 962, health: 'good', privacy: 'public', chat: 'c1' },
      '/stream/youtube/chat': {
        ok: true, pageToken: 'p1', pollMs: 60000,
        messages: [
          say('m2', 'Otto Brandt', 'What saw is that?', '#7a4b2c', '#f0c8a0', '#6a4a2a', { sponsor: true }),
          say('m3', 'Moderator Finch', 'Parts list is in the description', '#2f6b4f', '#b5825a', '#14161f', { moderator: true }),
          say('m4', 'Rin Sato', 'First time here, this is so relaxing', '#6b3d7a', '#f0d0b0', '#1a1a2a'),
        ],
      },
    },
  };
};

const CHAT = [
  ['pixelkoi', '#ff7ac6', 'that clutch was unreal'],
  ['orbit_fox', '#ffb347', 'how long until the next map?'],
  ['tinybyte', '#6ee7b7', 'first time catching this live, hello chat'],
  ['lowtide_live', '#7cc4ff', 'the new overlay looks great'],
  ['mossy', '#c4a7ff', 'gg, one more round?'],
  ['nightowl', '#ffd166', 'clip it, clip it'],
  ['saltline', '#ff9f80', 'volume is perfect today'],
];

const ircLine = ([login, color, text], i) => `@color=${color};display-name=${login};id=m${i} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #vectorseven :${text}`;

export const twitch = () => ({
  answers: {
    '/stream/twitch/status': { connected: true, configured: true, login: 'vectorseven' },
    '/stream/twitch/stream': { ok: true, live: true, viewers: 842, title: 'Ranked climb, road to the top', game: 'Star Circuit' },
  },
  events: { obs: { obsStreaming: true, obsRecording: false, obsScene: 'Gameplay', obsInputs: [], obsMutes: {}, obsVolumes: {} } },
  sockets: { 'irc-ws.chat.twitch.tv': CHAT.map(ircLine).join('\r\n') },
});

export const twitchwatch = () => {
  const channel = (login, name, game, title, viewers, image) => ({ login, name, game, title, viewers, image: dataUri(image) });
  const channels = [
    channel('vectorseven', 'VECTOR SEVEN', 'Star Circuit', 'Ranked climb, road to the top', 8420, portrait({ wall: '#5b2a86', skin: '#d9a06b', hair: '#14161f' })),
    channel('hollowcoast', 'HollowCoast', 'Music', 'Writing an album live, day 12', 1310, portrait({ wall: '#1f6a8c', skin: '#f0c8a0', hair: '#6a4a2a' })),
    channel('tinkerfield', 'TinkerField', 'Maker & Crafts', 'Restoring an old arcade cabinet', 942, portrait({ wall: '#8a3d4f', skin: '#b5825a', hair: '#2a1d1a' })),
    channel('quietpixel', 'QuietPixel', 'Moon Farm', 'Cozy Sunday, year two', 655, portrait({ wall: '#2f6b4f', skin: '#e0b48c', hair: '#3a2a1a' })),
    channel('saltline', 'Saltline', 'Deep Haul', 'Long haul to the outer ring', 318, portrait({ wall: '#7a4b2c', skin: '#f0d0b0', hair: '#1a1a2a' })),
  ];
  return {
    answers: {
      '/stream/twitch/status': { connected: true, configured: true, login: 'vectorseven' },
      '/stream/twitch/followed': { ok: true, channels },
      '/stream/twitch/top': { ok: true, channels },
    },
    frames: { 'player.twitch.tv': frame(skyline({ seed: 7 })) },
    // The chat beside the picture (off on a new tile) has its own lines to show.
    sockets: { 'irc-ws.chat.twitch.tv': CHAT.map(ircLine).join('\r\n') },
    stage: 'document.querySelector(".tww-row")?.click()',
  };
};

export const wavelink = () => {
  const mixes = [{ id: 'personal', name: 'Personal', level: 72, muted: false }, { id: 'stream', name: 'Stream', level: 84, muted: false }, { id: 'chat', name: 'Chat', level: 64, muted: false }];
  const channel = (id, name, personal, stream, meter, effects = []) => ({
    id, name, meter, effects, available: true,
    mixes: [{ id: 'personal', level: personal, muted: false }, { id: 'stream', level: stream, muted: false }, { id: 'chat', level: 60, muted: false }],
  });
  const feed = {
    enabled: true, connected: true, dialect: 3, version: '3.2.0',
    capabilities: { meters: true, effects: true, outputDevices: true },
    mixes,
    channels: [
      channel('mic', 'Microphone', 80, 88, [62, 58], [{ id: 'gate', name: 'Noise gate', enabled: true }, { id: 'comp', name: 'Compressor', enabled: true }]),
      channel('game', 'Game', 54, 42, [46, 49]),
      channel('music', 'Music', 38, 26, [33, 36]),
      channel('voice', 'Voice chat', 66, 70, [20, 18]),
    ],
    outputs: { mainId: 'hs', devices: [{ id: 'hs', name: 'Headset' }, { id: 'sp', name: 'Speakers' }] },
  };
  return { answers: { '/api/wavelink/state': feed }, events: { wavelink: feed } };
};

export const obs = () => {
  const inputs = ['Mic', 'Desktop', 'Music'];
  return {
    cards: { obs: { audio: { order: 4, size: 'normal', visible: false } } },
    answers: {
      '/obs/scenes': { ok: true, scenes: ['Gameplay', 'Just chatting', 'Be right back'] },
      '/actions/catalog': { actions: [], capabilities: { obsConfigured: true } },
    },
    events: {
      obs: {
        obsStreaming: true, obsRecording: true, obsScene: 'Gameplay',
        obsInputs: inputs, obsMutes: { Music: true }, obsVolumes: { Mic: 82, Desktop: 64, Music: 35 },
      },
      obs_preview: { image: dataUri(skyline({ seed: 7, h: 180 })) },
    },
  };
};

export const streamerbot = (now) => {
  const item = (type, user, ago, more) => ({ type, user, at: now - ago, ...more });
  const recent = [
    item('RewardRedemption', 'pixelkoi', 31 * MIN, { text: 'Hydrate!' }),
    item('Follow', 'tinybyte', 22 * MIN),
    item('Cheer', 'orbit_fox', 14 * MIN, { amount: 500, text: 'That last round was unreal' }),
    item('Raid', 'lowtide_live', 9 * MIN, { amount: 42 }),
    item('Sub', 'mossy', 3 * MIN, { amount: 7 }),
    item('GiftSub', 'nightowl', 40 * 1000, { text: 'Gifted a sub to tinybyte' }),
  ];
  return {
    answers: { '/streamerbot/activity': { configured: true, connected: true, globals: { deaths: 12, goal: 'Reach the final boss' }, recent } },
  };
};
