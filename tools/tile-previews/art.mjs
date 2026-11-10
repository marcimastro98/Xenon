// Invented pictures for the Add list's shots: covers, camera views, stream frames.
// Plain SVG drawn from a seed, so no third-party art and nothing from this PC.

// The same seed gives the same picture, so a re-shoot changes nothing by itself.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function ridge(rand, w, h, base, rough) {
  const points = [];
  for (let x = 0; x <= w; x += w / 12) points.push(`${Math.round(x)},${Math.round(base + (rand() - 0.5) * rough)}`);
  return `M0,${h} L${points.join(' L')} L${w},${h} Z`;
}

function svg(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}

function sky(top, bottom) {
  return `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#s)"/>`;
}

// Hills under a sun: a holiday photo, a game's open world.
export function landscape({ seed = 1, top = '#27306b', bottom = '#ff9a62', sun = '#ffe2a8', hills = ['#5a3f7d', '#3a2b5e', '#1d1a3a'], w = 640, h = 400 } = {}) {
  const rand = random(seed);
  const layers = hills.map((fill, i) => `<path fill="${fill}" d="${ridge(rand, w, h, h * (0.55 + i * 0.42 / hills.length), h * 0.2)}"/>`).join('');
  return svg(w, h, `${sky(top, bottom)}<circle cx="${w * (0.3 + rand() * 0.4)}" cy="${h * 0.42}" r="${h * 0.13}" fill="${sun}"/>${layers}`);
}

// A night skyline with lit windows: a game's city, a stream's main scene.
export function skyline({ seed = 2, top = '#10122e', bottom = '#5b2a86', glow = '#ff4fa3', lit = '#ffd66b', w = 640, h = 360 } = {}) {
  const rand = random(seed);
  let body = sky(top, bottom) + `<circle cx="${w * 0.72}" cy="${h * 0.3}" r="${h * 0.16}" fill="${glow}" opacity="0.75"/>`;
  for (let row = 0; row < 2; row += 1) {
    for (let x = -10; x < w;) {
      const bw = 34 + rand() * 46;
      const bh = h * (row ? 0.28 + rand() * 0.3 : 0.42 + rand() * 0.34);
      body += `<rect x="${x.toFixed(0)}" y="${(h - bh).toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" fill="${row ? '#0c0d22' : '#1b1b42'}"/>`;
      for (let wy = h - bh + 10; wy < h - 8; wy += 14) {
        for (let wx = x + 7; wx < x + bw - 8; wx += 12) {
          if (rand() < 0.3) body += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="6" height="8" fill="${lit}" opacity="${row ? 0.9 : 0.5}"/>`;
        }
      }
      x += bw + 3;
    }
  }
  return svg(w, h, body);
}

// Islands floating over the clouds, an airship between them: a game's sky world.
export function skyIslands({ w = 640, h = 520 } = {}) {
  const cloud = (x, y, s) => `<g fill="#fff" opacity="0.9"><ellipse cx="${x}" cy="${y}" rx="${s * 1.7}" ry="${s * 0.46}"/><ellipse cx="${x - s * 0.6}" cy="${y - s * 0.26}" rx="${s * 0.72}" ry="${s * 0.44}"/><ellipse cx="${x + s * 0.5}" cy="${y - s * 0.34}" rx="${s * 0.82}" ry="${s * 0.54}"/></g>`;
  const island = (x, y, s) => `<path fill="#8a5a3c" d="M${x - s},${y} L${x + s},${y} L${x + s * 0.5},${y + s * 0.6} L${x + s * 0.12},${y + s * 1.05} L${x - s * 0.34},${y + s * 0.56} Z"/><path fill="#a9e36a" d="M${x - s * 1.06},${y + 2} Q${x},${y - s * 0.3} ${x + s * 1.06},${y + 2} Z"/>`;
  const ship = (x, y, s) => `<ellipse cx="${x}" cy="${y}" rx="${s}" ry="${s * 0.38}" fill="#ffb35c"/><path fill="#fff4dd" d="M${x - s * 0.95},${y} Q${x},${y + s * 0.36} ${x + s * 0.95},${y} Z"/><rect x="${x - s * 0.3}" y="${y + s * 0.5}" width="${s * 0.6}" height="${s * 0.2}" rx="${s * 0.06}" fill="#5a3a2a"/><path stroke="#5a3a2a" stroke-width="2" d="M${x - s * 0.26},${y + s * 0.5} L${x - s * 0.4},${y + s * 0.3} M${x + s * 0.26},${y + s * 0.5} L${x + s * 0.4},${y + s * 0.3}"/>`;
  return svg(w, h, sky('#2f8fe8', '#ffe2b0') + cloud(w * 0.2, h * 0.26, 46) + island(w * 0.72, h * 0.32, 110) + island(w * 0.2, h * 0.56, 80) + ship(w * 0.46, h * 0.16, 54) + cloud(w * 0.8, h * 0.72, 64) + cloud(w * 0.34, h * 0.86, 88));
}

// A lighthouse on a rock, its beam over a rough sea: a game's coast at night.
export function lighthouse({ w = 640, h = 520 } = {}) {
  const wave = (y, amp, fill) => {
    const step = w / 8;
    let d = `M0,${y}`;
    for (let x = 0; x < w; x += step) d += ` q${step / 2},${x / step % 2 ? amp : -amp} ${step},0`;
    return `<path fill="${fill}" d="${d} L${w},${h} L0,${h} Z"/>`;
  };
  const x = w * 0.64;
  const top = h * 0.2;
  const tower = `<path fill="#f4f1e4" d="M${x - 26},${top} L${x + 26},${top} L${x + 42},${h * 0.66} L${x - 42},${h * 0.66} Z"/><path fill="#e0483e" d="M${x - 31},${h * 0.3} L${x + 31},${h * 0.3} L${x + 35},${h * 0.4} L${x - 35},${h * 0.4} Z M${x - 38},${h * 0.5} L${x + 38},${h * 0.5} L${x + 41},${h * 0.6} L${x - 41},${h * 0.6} Z"/><rect x="${x - 22}" y="${top - 34}" width="44" height="34" fill="#ffe27a"/><path fill="#e0483e" d="M${x - 30},${top - 34} L${x},${top - 66} L${x + 30},${top - 34} Z"/>`;
  const beam = `<path fill="#ffe27a" opacity="0.45" d="M${x},${top - 18} L0,${h * 0.02} L0,${h * 0.3} Z"/>`;
  const rock = `<path fill="#16323f" d="M${w * 0.4},${h * 0.76} L${x - 70},${h * 0.64} L${x + 60},${h * 0.63} L${w * 0.92},${h * 0.78} Z"/>`;
  return svg(w, h, sky('#123a78', '#22b5a6') + beam + tower + rock + wave(h * 0.72, 22, '#1590a8') + wave(h * 0.8, 26, '#0f6f93') + wave(h * 0.9, 20, '#0a4f73'));
}

// A volcano with its lava running down and embers in the air: a game's burning land.
export function volcano({ seed = 7, w = 640, h = 520 } = {}) {
  const rand = random(seed);
  const crater = w * 0.56;
  const embers = Array.from({ length: 34 }, () => `<circle cx="${(crater + (rand() - 0.5) * w * 0.8).toFixed(0)}" cy="${(rand() * h * 0.5).toFixed(0)}" r="${(1.5 + rand() * 3).toFixed(1)}" fill="#ffd27a" opacity="${(0.5 + rand() * 0.5).toFixed(2)}"/>`).join('');
  const lava = `<path fill="none" stroke="#ff7a2a" stroke-width="16" stroke-linecap="round" d="M${crater - 6},${h * 0.3} q-30,70 -6,120 t-46,130"/><path fill="none" stroke="#ffc94a" stroke-width="7" stroke-linecap="round" d="M${crater - 6},${h * 0.3} q-30,70 -6,120 t-46,130"/><path fill="none" stroke="#ff7a2a" stroke-width="11" stroke-linecap="round" d="M${crater + 20},${h * 0.31} q26,60 52,88 t30,110"/>`;
  const cone = `<path fill="#3c1b2e" d="M${crater - 58},${h * 0.29} L${crater + 58},${h * 0.29} L${w * 1.08},${h} L${-w * 0.08},${h} Z"/><ellipse cx="${crater}" cy="${h * 0.29}" rx="60" ry="13" fill="#ffc94a"/>`;
  return svg(w, h, sky('#4a1a62', '#ff8a3d') + `<circle cx="${crater}" cy="${h * 0.28}" r="${h * 0.24}" fill="#ffb347" opacity="0.4"/>` + embers + cone + lava + `<path fill="#1e0f1e" d="${ridge(rand, w, h, h * 0.88, h * 0.1)}"/>`);
}

// A round head and shoulders on a coloured wall: a chat avatar, a webcam corner.
export function portrait({ wall = '#3d4f8a', skin = '#d9a06b', hair = '#2a1d1a', shirt = '#14161f', w = 160, h = 160 } = {}) {
  return svg(w, h, `<rect width="100%" height="100%" fill="${wall}"/><ellipse cx="${w / 2}" cy="${h * 1.02}" rx="${w * 0.42}" ry="${h * 0.36}" fill="${shirt}"/><circle cx="${w / 2}" cy="${h * 0.44}" r="${w * 0.22}" fill="${skin}"/><path fill="${hair}" d="M${w * 0.27},${h * 0.42} a${w * 0.23},${w * 0.23} 0 0 1 ${w * 0.46},0 q-${w * 0.2},-${h * 0.13} -${w * 0.46},0 Z"/>`);
}

// A wide outdoor view, the way a doorbell or a yard camera sees it.
export function yard({ seed = 3, night = false, zoom = 1, mirror = false, w = 640, h = 360 } = {}) {
  const rand = random(seed);
  const ground = night ? '#1d2626' : '#4d5c47';
  const wall = night ? '#2c3336' : '#8a8f8c';
  const roof = night ? '#171c20' : '#4b4240';
  const trees = Array.from({ length: 5 }, (_, i) => {
    const x = w * (0.04 + i * 0.22 + rand() * 0.05);
    const r = h * (0.1 + rand() * 0.06);
    return `<rect x="${x - 4}" y="${h * 0.46}" width="8" height="${h * 0.16}" fill="#2b2320"/><circle cx="${x}" cy="${h * 0.4}" r="${r}" fill="${night ? '#1a2a24' : '#3f5e3f'}"/>`;
  }).join('');
  const house = `<rect x="${w * 0.52}" y="${h * 0.34}" width="${w * 0.36}" height="${h * 0.3}" fill="${wall}"/><path fill="${roof}" d="M${w * 0.49},${h * 0.35} L${w * 0.7},${h * 0.17} L${w * 0.91},${h * 0.35} Z"/><rect x="${w * 0.62}" y="${h * 0.44}" width="${w * 0.07}" height="${h * 0.2}" fill="${night ? '#f6c766' : '#39302c'}"/><rect x="${w * 0.74}" y="${h * 0.42}" width="${w * 0.08}" height="${h * 0.1}" fill="${night ? '#f6c766' : '#a9c4d6'}"/>`;
  const path = `<path fill="${night ? '#3a4040' : '#a39c8e'}" d="M${w * 0.6},${h * 0.64} L${w * 0.7},${h * 0.64} L${w * 0.86},${h} L${w * 0.34},${h} Z"/>`;
  // Each camera looks at the same house from its own place: closer, or from the other side.
  const lens = `translate(${mirror ? w : 0} 0) scale(${mirror ? -zoom : zoom} ${zoom}) translate(${-w * 0.7 * (1 - 1 / zoom)} ${-h * 0.5 * (1 - 1 / zoom)})`;
  return svg(w, h, `${sky(night ? '#0d1320' : '#7ea3c4', night ? '#2a3548' : '#dfe6dc')}<g transform="${lens}">${trees}<rect y="${h * 0.62}" width="100%" height="${h * 0.38}" fill="${ground}"/>${house}${path}</g>`);
}

// A square album cover: a gradient with one big shape, in the demo's own style.
export function cover({ from = '#1ed760', to = '#0b6b39', glyph = '◈', w = 300 } = {}) {
  return svg(w, w, `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="66%" font-family="sans-serif" font-size="${w * 0.46}" font-weight="800" text-anchor="middle" fill="rgba(255,255,255,.82)">${glyph}</text>`);
}

// A small app icon for a notification row: a coloured square with one letter.
export function appIcon({ color = '#4f7cff', letter = 'M', w = 64 } = {}) {
  return svg(w, w, `<rect width="100%" height="100%" rx="${w * 0.22}" fill="${color}"/><text x="50%" y="70%" font-family="sans-serif" font-size="${w * 0.56}" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text>`);
}

// A plain website, as the embedded browser shows it: a guide page of an invented
// outdoors magazine, with a hero picture, a heading and three cards.
export function webpage({ w = 960, h = 640 } = {}) {
  const text = (x, y, size, weight, fill, body) => `<text x="${x}" y="${y}" font-family="Georgia,serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${body}</text>`;
  const card = (x, title, line, tint) => `<rect x="${x}" y="452" width="280" height="150" fill="${tint}"/>${text(x + 16, 500, 22, 700, '#23201b', title)}${text(x + 16, 532, 15, 400, '#5b554b', line)}`;
  const nav = text(40, 42, 24, 700, '#23201b', 'Lantern Trail') + text(640, 41, 15, 400, '#5b554b', 'Guides') + text(716, 41, 15, 400, '#5b554b', 'Maps') + text(782, 41, 15, 400, '#5b554b', 'Gear');
  const hero = landscape({ seed: 19, w, h: 290 }).replace('<svg ', '<svg y="64" ');
  const head = text(40, 262, 44, 700, '#fff', 'Five quiet walks for autumn') + text(40, 296, 18, 400, '#fff', 'Short routes, good views, no crowds');
  const cards = card(40, 'Ridge loop', '8 km, about three hours', '#e9e0cf') + card(340, 'Old mill path', '5 km, easy, shaded', '#dfe6d6') + card(640, 'Lake shore', '11 km, flat, windy', '#d9e4e8');
  return svg(w, h, `<rect width="100%" height="100%" fill="#f6f1e7"/>${hero}${nav}${head}${text(40, 412, 28, 700, '#23201b', 'This week')}${cards}`);
}

// A plain shield in two colours: where a tile shows a club's crest, which is not ours to draw.
export function crest({ field = '#1d4f9c', band = '#f4f7fa', w = 96 } = {}) {
  const shape = 'M48 4 88 14v38c0 22-16 36-40 48C24 88 8 74 8 52V14z';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 96 104"><defs><clipPath id="c"><path d="${shape}"/></clipPath></defs><g clip-path="url(#c)"><rect width="96" height="104" fill="${field}"/><rect x="36" width="24" height="104" fill="${band}"/></g><path d="${shape}" fill="none" stroke="#ffffff" stroke-opacity=".35" stroke-width="3"/></svg>`;
}

export function dataUri(markup) {
  return 'data:image/svg+xml;base64,' + Buffer.from(markup, 'utf8').toString('base64');
}

// A third-party player's page, stubbed with one still picture.
export function frame(markup) {
  return `<!doctype html><html><body style="margin:0;background:#000;overflow:hidden"><img style="width:100vw;height:100vh;object-fit:cover" src="${dataUri(markup)}"></body></html>`;
}
