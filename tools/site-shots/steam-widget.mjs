// The Store's Steam widget for the home's picture: the real package, decoded from its
// share code and run in the tile's real frame, on invented games with drawn covers.
// No real game, cover or account: the widget asks Steam, and this answers instead.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { lighthouse, skyIslands, skyline, volcano } from '../tile-previews/art.mjs';

const { decodePreset } = createRequire(import.meta.url)('../../server/js/preset-share.js');
const SHARE_CODE = new URL('../../docs/community/codes/tgk-steam-launcher-battery.txt', import.meta.url);

const FILE_TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json' };
const COVER_SIZE = { w: 640, h: 520 };
// The tile's frame carries the sandbox's CSP and shows only a page that accepts it.
const ACCEPTS_FRAME_CSP = { 'Allow-CSP-From': '*' };

// The card writes the title straight on the cover: dark under it, or the city's windows cross the text.
const captioned = (markup) => markup.replace('</svg>', '<defs><linearGradient id="caption" x1="0" y1="0" x2="0" y2="1"><stop offset=".5" stop-color="#05060c" stop-opacity="0"/><stop offset="1" stop-color="#05060c" stop-opacity=".92"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#caption)"/></svg>');

// The widget lists at most four. The first is the one playing, as in the rest of the site.
const GAMES = [
  { appid: 910001, name: 'Cyberfall', minutes: 7260, recent: 640, cover: skyline({ seed: 41, top: '#1a1f6e', bottom: '#d43fa8', glow: '#ff7ac0', ...COVER_SIZE }) },
  { appid: 910002, name: 'Skyharbor', minutes: 4110, recent: 280, cover: skyIslands(COVER_SIZE) },
  { appid: 910003, name: 'Tidewarden', minutes: 2380, recent: 95, cover: lighthouse(COVER_SIZE) },
  { appid: 910004, name: 'Emberline', minutes: 1320, recent: 40, cover: volcano(COVER_SIZE) },
];

function packageFiles(payload) {
  const files = {};
  for (const { path, data } of payload.files) {
    files[`/sdk/widget/${payload.id}/${path}`] = { type: FILE_TYPES[path.split('.').pop()], headers: ACCEPTS_FRAME_CSP, body: Buffer.from(data, 'base64') };
  }
  return files;
}

function coverFiles(id) {
  const files = {};
  for (const { appid, cover } of GAMES) {
    const url = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
    files[`/sdk/asset/${id}?u=${encodeURIComponent(url)}`] = { type: 'image/svg+xml', body: captioned(cover) };
  }
  return files;
}

// What Steam would say: one body serves the recent games and the player's presence.
function steamReply() {
  const [playing] = GAMES;
  return JSON.stringify({
    response: {
      games: GAMES.map(({ appid, name, minutes, recent }) => ({ appid, name, playtime_forever: minutes, playtime_2weeks: recent })),
      players: [{ gameid: String(playing.appid), gameextrainfo: playing.name }],
    },
  });
}

export function steamWidget() {
  const { data } = decodePreset(readFileSync(SHARE_CODE, 'utf8'));
  const { id, payload } = data;
  const manifest = JSON.parse(Buffer.from(payload.files.find((f) => f.path === 'manifest.json').data, 'base64').toString('utf8'));
  return {
    settings: {
      sdkWidgets: {
        enabled: true,
        assign: { custom: id },
        grants: { [id]: { streams: manifest.streams, actions: manifest.actions, hosts: manifest.hosts, storage: true, secrets: true } },
      },
    },
    answers: {
      '/sdk/widgets': { ok: true, packages: [manifest] },
      '/sdk/fetch': { ok: true, status: 200, contentType: 'application/json', body: steamReply() },
      '/sdk/store': { ok: true, value: '76500000000000001' },
      '/sdk/secret': { ok: true, names: ['apiKey'] },
    },
    files: { ...packageFiles(payload), ...coverFiles(id) },
    // The widget spaces its calls 1.25 s apart: the games, then who is playing.
    stage: 'new Promise((done) => setTimeout(done, 4000))',
  };
}
