// Invented data for the pump face pictures (shoot.mjs): readings, a song, the
// weather, and two pictures drawn here as PNG, so nothing is read from this PC.
import { deflateSync } from 'node:zlib';

export const SYSTEM = {
  cpu: 37, gpu: 88, cpuTemp: 61, gpuTemp: 72, memory: { percent: 54 },
  vramUsed: 9200, vramTotal: 16384, fps: 144, power: { total: 312 },
  cpuClockMHz: 5120, gpuClockMHz: 2655,
};
export const HOT_SYSTEM = { ...SYSTEM, cpuTemp: 93, gpuTemp: 84 };
export const MAC_SYSTEM = { ...SYSTEM, fps: null, gpuTemp: null };

export const WEATHER = { ok: true, code: 116, tempC: 14, condition: 'Partly cloudy' };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A size x size PNG whose pixel colour is `paint(x, y)` -> [r, g, b]. */
// `alpha`: paint gives [r, g, b, a], as an app's icon with see-through corners.
export function png(size, paint, alpha = false) {
  const px = alpha ? 4 : 3;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * px);
    for (let x = 0; x < size; x += 1) row.set(paint(x / size, y / size), 1 + x * px);
    rows.push(row);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, k) => Math.round(a + (b - a) * k);

// A made-up album cover: a dusk gradient with a sun low on it.
export const COVER_PNG = png(256, (x, y) => {
  const sun = Math.hypot(x - 0.62, y - 0.58) < 0.18;
  if (sun) return [255, mix(196, 120, y), mix(120, 60, y)];
  return [mix(24, 196, y), mix(32, 64, y * x), mix(92, 120, x)];
});

// A made-up photo for the Picture face: hills under a pale sky.
export const PHOTO_PNG = png(256, (x, y) => {
  const hill = y > 0.62 + 0.08 * Math.sin(x * 7);
  return hill ? [mix(30, 18, y), mix(92, 50, y), mix(64, 40, y)] : [mix(140, 220, y), mix(180, 226, y), mix(230, 236, y)];
});

export const MEDIA = {
  title: 'Long Way to the Coast', artist: 'The Paper Lanterns', album: 'Night Roads',
  playbackStatus: 'Playing', positionMs: 83000, duration: 214, thumbnail: '/uploads/pump-cover.png',
};
export const MEDIA_LONG = {
  ...MEDIA, title: 'An Unreasonably Long Song Title That Keeps Going Past the Edge', artist: 'Orchestra of the Very Long Name',
};

export const UPLOADS = { 'pump-cover.png': COVER_PNG, 'pump-photo.png': PHOTO_PNG };

// A song a player lists with no cover, and a browser tab heard making sound with no song.
export const MEDIA_NO_COVER = { ...MEDIA, thumbnail: null };
export const MEDIA_TAB_SOUND = { fallback: true, app: 'Google Chrome', title: 'Google Chrome', artist: '', playbackStatus: 'Playing', thumbnail: null };

export const NOTIFICATION = { app: 'Messages', title: 'Sam', body: 'Running ten minutes late, save me a seat by the window.' };
// The small icon Windows hands with a notification: 24 px, a rounded tile drawn here.
// A round app logo with soft edges, at the 48 px Windows hands over.
const ICON_PNG = png(48, (x, y) => [mix(80, 40, y), mix(160, 120, x), mix(250, 210, y), Math.round(255 * Math.max(0, Math.min(1, (0.44 - Math.hypot(x - 0.5, y - 0.5)) * 48)))], true);
export const NOTIFICATION_ICON = { ...NOTIFICATION, app: 'Snipping Tool', title: '', body: '', icon: 'data:image/png;base64,' + ICON_PNG.toString('base64') };
export const CALL = { calls: [{ caller: 'Alex', app: 'Phone' }] };
