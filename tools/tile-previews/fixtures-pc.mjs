// Invented state for the tiles about this computer: its devices, power, disks, files,
// notifications, the embedded browser and the local chat. Nothing is read from this PC.

import { appIcon, dataUri, landscape, webpage } from './art.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

export const battery = () => {
  const feed = {
    devices: [
      { name: 'VIRTUOSO MAX', percent: 68, charging: false, source: 'corsair' },
      { name: 'K100 AIR', percent: 92, charging: true, source: 'corsair' },
      { name: 'DARK CORE PRO', percent: 41, charging: false, source: 'corsair' },
      { name: 'Game controller', percent: 16, charging: false, source: 'bluetooth' },
      { name: 'Wireless earbuds', percent: 74, charging: false, source: 'bluetooth' },
      { name: 'Presenter remote', percent: 57, charging: false, source: 'bluetooth' },
    ],
    sources: { corsair: true, bluetooth: true },
  };
  return { answers: { '/api/battery': feed }, events: { battery: feed } };
};

export const power = (now) => {
  const pc = { cpu: 78.4, gpu: 241, psu: 386, total: 319.4 };
  const energy = [
    { id: 'sensor.desk_plug', name: 'Desk plug', state: '412', unit: 'W', deviceClass: 'power' },
    { id: 'sensor.solar', name: 'Solar today', state: '6.84', unit: 'kWh', deviceClass: 'energy' },
  ];
  const hours = Array.from({ length: 24 }, (_, i) => {
    const load = 0.45 + ((i * 7) % 10) / 16;
    return { t: new Date(now - (23 - i) * HOUR).toISOString().slice(0, 13), cpuWatts: { avg: 40 * load + 22, max: 60 * load + 30 }, gpuWatts: { avg: 180 * load + 12, max: 240 * load + 20 } };
  });
  return {
    answers: {
      '/system': { power: pc, sensorAccess: 'ok' },
      '/api/homeassistant/state': { energy },
      '/api/guardian/history': { enabled: true, hours },
    },
    events: { homeassistant: { energy } },
  };
};

export const notifications = (now) => {
  const row = (id, app, letter, color, ago, title, body) => ({ id, app, at: now - ago, title, body, icon: dataUri(appIcon({ letter, color })) });
  const items = [
    row('n1', 'Messages', 'M', '#2fb45a', 2 * MIN, 'Nina Vale', 'Are we still on for tonight? I can bring the second monitor.'),
    row('n2', 'Mail', 'E', '#2f7ce0', 18 * MIN, 'Parts delivery', 'Your order ships tomorrow between 9 and 12.'),
    row('n3', 'Team chat', 'T', '#7a5be6', 47 * MIN, 'Design review', 'Theo: the new build is up, feedback by Friday please.'),
    row('n4', 'Calendar', 'C', '#e0653a', 2 * HOUR, 'Stream night', 'Tomorrow at 21:00'),
    row('n5', 'Mail', 'E', '#2f7ce0', 3 * HOUR, 'Harbor Print', 'Your poster proof is ready to review.'),
  ];
  const flags = { enabled: true, hide: false, toast: false, excluded: [] };
  return {
    settings: { windowsNotifications: flags },
    answers: { '/notifications/windows': { ok: true, ...flags, state: 'allowed', supported: true, items } },
  };
};

export const lighting = () => ({
  answers: {
    '/api/lighting/status': {
      available: true, connected: true, enabled: true, manualColor: '',
      animation: { style: 'aurora', color: '#19d3da', palette: [] },
      devices: [
        { id: 'pump', name: 'Liquid cooler', mode: 'follow' },
        { id: 'fans', name: 'Case fans', mode: 'animation' },
        { id: 'keys', name: 'Keyboard', mode: 'color', modeColor: '#7c5cff' },
      ],
      providers: [{ name: 'WLED', devices: [{ id: 'desk', name: 'Desk strip', mode: 'album' }] }],
    },
  },
});

export const slideshow = () => ({
  settings: {
    slideshow: {
      images: [1, 2, 3, 4, 5].map((n) => ({ name: `Trip ${n}`, uri: `/uploads/slideshow-trip-${n}.png` })),
      intervalMs: 120000, fit: 'cover',
    },
  },
  files: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`/uploads/slideshow-trip-${n}.png`, { type: 'image/svg+xml', body: landscape({ seed: n * 5, hills: ['#c07a7f', '#96597c', '#6b4274', '#44305f', '#231d40'] }) }])),
});

export const devclean = () => {
  const image = (id, name, bytes, more = {}) => ({ id, name, bytes, reclaimable: bytes, ...more });
  const overview = {
    ok: true, reclaimable: 61.4 * GB,
    docker: {
      available: true, bytes: 48.2 * GB, reclaimable: 31.7 * GB,
      items: [image('d1', 'Unused images', 22.4 * GB), image('d2', 'Build cache', 9.3 * GB)],
    },
    ollama: {
      available: true, bytes: 26.5 * GB, reclaimable: 18.9 * GB,
      items: [image('o1', 'atlas-chat-70b', 12.1 * GB), image('o2', 'old-coder-13b', 6.8 * GB)],
    },
    vscode: {
      available: true, bytes: 9.8 * GB, reclaimable: 4.6 * GB,
      items: [image('v1', 'Old extension versions', 3.2 * GB), image('v2', 'Workspace storage', 1.4 * GB)],
    },
    vhdx: { available: true, bytes: 64 * GB, reclaimable: 6.2 * GB, items: [{ id: 'w1', name: 'Dev Linux', file: 'ext4.vhdx', bytes: 64 * GB, offer: 6.2 * GB }] },
  };
  return { answers: { '/api/features/devclean': { unlocked: true }, '/api/devclean/overview': overview } };
};

export const disk = (now) => {
  const total = 1830 * GB;
  const folder = (p, s, id) => ({ p, s, id });
  const overview = {
    ok: true, root: 'C:\\', rootId: 'r0', total: 1262 * GB,
    volume: { capacity: total, free: 568 * GB },
    kinds: { video: 412 * GB, game: 386 * GB, app: 158 * GB, document: 64 * GB, image: 92 * GB, audio: 41 * GB, archive: 58 * GB, other: 51 * GB },
    categories: { temp: { bytes: 7.4 * GB, count: 1820 }, browserCache: { bytes: 3.1 * GB, count: 640 }, pkgCache: { bytes: 12.6 * GB, count: 210 } },
    dupes: [{ wasted: 8.2 * GB }, { wasted: 3.4 * GB }],
    insights: { growth: { days: 30, folders: [{ p: 'C:\\Games', delta: 48 * GB }, { p: 'C:\\Videos', delta: 21 * GB }] }, forecast: { state: 'stable', spanDays: 30 } },
    staleFiles: [], topFiles: [], index: {},
  };
  return {
    answers: {
      '/disk/status': { ok: true, helper: true, roots: [{ i: 0, path: 'C:\\', drive: 'C:', label: 'System', model: 'NVMe SSD', fileSystem: 'NTFS' }], index: { ready: true, files: 1248000, ramMB: 96, at: now - 4 * MIN } },
      '/disk/overview': overview,
      '/disk/browse': {
        ok: true, path: 'C:\\', total: 1262 * GB, directFiles: [], directBytes: 2 * GB, otherBytes: 26 * GB,
        children: [
          folder('C:\\Games', 386 * GB, 'g'), folder('C:\\Videos', 412 * GB, 'v'), folder('C:\\Program Files', 158 * GB, 'p'),
          folder('C:\\Pictures', 92 * GB, 'i'), folder('C:\\Projects', 74 * GB, 'j'), folder('C:\\Music', 41 * GB, 'm'), folder('C:\\Downloads', 71 * GB, 'd'),
        ],
      },
    },
  };
};

export const search = (now) => {
  const file = (name, dir, size, ago) => ({ id: name, name, dir, path: `${dir}\\${name}`, size, mtime: now - ago, ext: name.split('.').pop() });
  const home = 'C:\\Users\\you';
  return {
    answers: {
      '/search': {
        ok: true, index: 'ready', wds: 'ok', chips: [],
        results: [
          { id: 'f1', kind: 'folder', name: 'Lake trip 2026', dir: `${home}\\Pictures`, path: `${home}\\Pictures\\Lake trip 2026`, files: 214 },
          file('Lake trip budget.xlsx', `${home}\\Documents`, 48_000, 2 * DAY),
          file('Lake trip packing list.pdf', `${home}\\Documents`, 212_000, 5 * DAY),
          file('Lake trip route.gpx', `${home}\\Downloads`, 96_000, 6 * DAY),
          file('Lake trip sunset.jpg', `${home}\\Pictures\\Lake trip 2026`, 5_400_000, 9 * DAY),
          file('Lake trip video.mp4', `${home}\\Videos`, 812_000_000, 9 * DAY),
        ],
      },
    },
    stage: 'document.querySelector(".search-widget-mount")._searchUI.setQuery("lake trip")',
  };
};

export const remote = () => ({
  answers: {
    '/remote/status': { installed: { sunshine: true, tailscale: true }, ready: true, blocked: false, connectedClients: [{}], tailscale: { ip: '100.64.0.7' } },
    '/remote/screens': [{ id: 1, name: 'Main display', active: true }, { id: 2, name: 'Side display', active: false }],
  },
});

export const browser = () => ({
  answers: { '/embedded-browser/available': { available: true, canInstall: false } },
  settings: { browserTiles: { browser: { tabs: [{ url: 'https://lanterntrail.example/guides' }], active: 0, chromeHidden: false } } },
  relay: { url: 'https://lanterntrail.example/guides', image: dataUri(webpage()) },
});

export const chat = () => ({
  settings: { aiProvider: 'xenon' },
  answers: { '/api/ai/xenon/balance': { ok: true, balance: 840, included: 500, monthly: 500, topup: 340 } },
  stage: `_aiDropWelcome();
_aiAppendBubble('user', 'How hot did my GPU get last night?');
_aiAppendBubble('assistant', 'It peaked at 71 °C around 22:40 and stayed near 64 °C for the rest of the evening.');
_aiAppendBubble('user', 'Good. Dim the desk lights a little.');
_aiAppendBubble('assistant', 'Done, the desk lights are at 40%.');`,
});

// The Add list puts this tile on the screen, where it is words over a game: the shot
// wears the overlay's look (data-layer) on an invented scene, not the dashboard's panel.
export const perf = () => {
  const scene = dataUri(landscape({ seed: 7, top: '#1b2a4a', bottom: '#c8734a', sun: '#ffd9a0', hills: ['#3f4a6b', '#2a3250', '#141a2e'], w: 720, h: 520 }));
  const frames = Array.from({ length: 120 }, (_, i) => 6.8 + ((i * 7) % 11) / 20 + (i === 84 ? 5 : 0));
  const feed = { active: true, process: 'Skyharbor.exe', fps: 142, avgFps: 141, low1Fps: 112, low01Fps: 96, frames };
  return {
    answers: { '/perf': feed },
    events: { perf: feed },
    crop: '#layer-root',
    stage: `const tile = document.querySelector('[data-dashboard-widget="perf"].dashboard-widget');
      const root = document.createElement('div');
      root.id = 'layer-root';
      root.style.cssText = 'position:fixed;left:0;top:0;width:720px;height:520px;z-index:9;background:center / cover url("${scene}")';
      const slot = document.createElement('div');
      slot.className = 'layer-slot';
      slot.style.cssText = 'position:absolute;left:32px;top:32px;width:420px;height:440px';
      slot.append(tile);
      root.append(slot);
      document.body.append(root);
      document.documentElement.setAttribute('data-layer', 'overlay');`,
  };
};
