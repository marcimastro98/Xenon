// What goes on the Microsoft Store page: the pictures, in the Store's order, the
// caption of each, and the checks every picture has to pass. All of it is the
// demo's canned English data; no picture carries another company's name.

export const SIZE = { width: 1920, height: 1080 };

export const SHOTS = [
  { id: 'dashboard', caption: 'Your PC at a glance on any spare screen' },
  { id: 'desktop', caption: 'Widgets on the desktop, with no second monitor' },
  { id: 'menu', caption: 'One menu for widgets, capture and shortcuts' },
  { id: 'performance', caption: 'FPS, 1% low and frame time over the game' },
  { id: 'gallery', caption: 'Screenshots, recordings and Instant Replay' },
  { id: 'bit', caption: 'Bit, the AI inside Xenon' },
  { id: 'maker', caption: 'Xenon Maker: build widgets without code' },
];

// Names the demo uses, and what the Store pictures say instead.
export const RELABEL = [
  [/AMD Ryzen[^,\n]*/g, 'Processor'],
  [/NVIDIA[^,\n]*/g, 'Graphics'],
  [/Cyberpunk2077(\.exe)?/g, 'Lantern Trail'],
  [/Spotify/g, 'Media Player'],
  [/Discord/g, 'Voice chat'],
  [/YouTube/g, 'Video'],
  [/Twitch/g, 'Live'],
  [/Steam/g, 'Games'],
  [/ on macOS/g, ''],
];

const BRANDS = /\b(amd|ryzen|nvidia|geforce|intel|corsair|xeneon|elgato|spotify|discord|youtube|twitch|steam|obs|cyberpunk\w*|windows|macos|microsoft|apple|xbox|playstation)\b/gi;

/** Every other company's name in a picture's text, once each. */
export function findBrands(text) {
  return [...new Set(String(text).match(BRANDS) || [])];
}

export function relabel(text) {
  return RELABEL.reduce((t, [from, to]) => t.replace(from, to), String(text));
}

/** Width and height from a PNG's header. */
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Page code: all the words a picture shows, the typed ones included. */
export function pageWords() {
  const typed = [...document.querySelectorAll('input,textarea')].map((el) => el.value);
  return [document.body.innerText, ...typed].join('\n');
}

/** Page code: every text is relabelled before the page paints it; a field's value has no
 *  text node to watch, so `window.__relabel` fixes those right before the picture. */
export function relabelScript() {
  const rules = RELABEL.map(([from, to]) => [from.source, to]);
  return `(() => {
  const rules = ${JSON.stringify(rules)}.map(([s, to]) => [new RegExp(s, 'g'), to]);
  const fix = () => {
    if (!document.body) return;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const next = rules.reduce((t, [from, to]) => t.replace(from, to), n.nodeValue);
      if (next !== n.nodeValue) n.nodeValue = next;
    }
    for (const el of document.querySelectorAll('input,textarea')) {
      const next = rules.reduce((t, [from, to]) => t.replace(from, to), el.value);
      if (next !== el.value) el.value = next;
    }
  };
  window.__relabel = fix;
  new MutationObserver(fix).observe(document, { subtree: true, childList: true, characterData: true });
})();`;
}
