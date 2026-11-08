// The built-in wallpapers, drawn as cut paper: concentric sheets of a low sun behind
// three hills, with a grain over the paper. build.mjs renders them to WebP, so the app
// paints a plain picture: an SVG filter would be redone at every new window size.
const VIEW_W = 2000;
const VIEW_H = 1000;
const SUN = [1180, 640];
const HILLS = [
  'M0 640 C 260 560 520 580 800 650 S 1380 740 2000 590 V1000 H0Z',
  'M0 740 C 340 650 700 700 1000 760 S 1560 810 2000 700 V1000 H0Z',
  'M0 860 C 420 780 860 840 1200 870 S 1720 890 2000 815 V1000 H0Z',
];
const RINGS = [900, 720, 560, 420, 300, 190, 100];

const grain = `<filter id='g' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' seed='7'/><feColorMatrix values='0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .9 -.28'/></filter>`;
const cut = (id, dy, blur, opacity) => `<filter id='${id}' x='-10%' y='-20%' width='120%' height='140%'><feDropShadow dx='0' dy='${dy}' stdDeviation='${blur}' flood-color='#000' flood-opacity='${opacity}'/></filter>`;

// One scene from its colours: the sky, a colour per ring (outermost first), one per hill.
function paperScene({ sky, rings, hills, shadow, grainOpacity }) {
  const [cx, cy] = SUN;
  const sheets = RINGS.map((r, i) => `<circle cx='${cx}' cy='${cy}' r='${r}' fill='${rings[i]}' filter='url(#r)'/>`).join('');
  const ground = HILLS.map((d, i) => `<path d='${d}' fill='${hills[i]}' filter='url(#s)'/>`).join('');
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${VIEW_W}' height='${VIEW_H}' viewBox='0 0 ${VIEW_W} ${VIEW_H}' preserveAspectRatio='xMidYMid slice'>`
    + `<defs>${grain}${cut('s', -6, 14, shadow)}${cut('r', 0, 18, shadow * 0.9)}</defs>`
    + `<rect width='${VIEW_W}' height='${VIEW_H}' fill='${sky}'/>${sheets}${ground}`
    + `<rect width='${VIEW_W}' height='${VIEW_H}' filter='url(#g)' opacity='${grainOpacity}' style='mix-blend-mode:overlay'/></svg>`;
}

export const WALLPAPERS = Object.freeze({
  dusk: paperScene({
    sky: '#161c30',
    rings: ['#1f2340', '#30274e', '#4c2b56', '#7a3055', '#a83e4e', '#c85a42', '#cc7a4a'],
    hills: ['#21455a', '#163349', '#0d2231'],
    shadow: 0.38,
    grainOpacity: 0.16,
  }),
  // The same hour for the Light appearance: dark text needs a pale sheet behind it.
  'dusk-light': paperScene({
    sky: '#e9edf3',
    rings: ['#e6e6f1', '#e8e0ec', '#eed9e2', '#f3d2d2', '#f6c9bb', '#f8bfa2', '#f9b48a'],
    hills: ['#c9dbe2', '#b7cfd9', '#a6c3cf'],
    shadow: 0.14,
    grainOpacity: 0.1,
  }),
});
