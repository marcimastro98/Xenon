'use strict';
// A widget that draws the person's own Bit (SDK stream `bit`, Xenon 5.3) in the MCP tools:
// the starter (widget_template `bit`), which carries the Bit kit, and what check_widget says
// about a widget that reads the stream. The rules are in docs/WIDGET_SDK.md ("Your own Bit").

const { bitKit } = require('../bit/kit.js');

const KIT = 'bit-kit.js';
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const fromB64 = (s) => { try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); } catch { return ''; } };

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="style.css">
  <script src="${KIT}" defer></script>
  <script src="main.js" defer></script>
</head>
<body>
  <main id="root">
    <div id="bit" class="bit"></div>
    <p id="name" class="name"></p>
    <button id="move" type="button">Wave</button>
  </main>
</body>
</html>
`;

const CSS = `:root { color-scheme: dark; --text: #f0f3f1; --muted: #a6b1ad; --line: #ffffff2e; }
html, body { margin: 0; height: 100%; background: transparent; color: var(--text); font-family: system-ui, sans-serif; }
#root { height: 100%; container-type: size; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2cqmin; padding: 4cqmin; box-sizing: border-box; }
.bit { width: 50cqmin; aspect-ratio: 1; }
.bit svg { width: 100%; height: 100%; }
.name { margin: 0; font-size: 8cqmin; color: var(--muted); }
button { min-height: 44px; padding: 0 16px; border-radius: 12px; border: 1px solid var(--line); background: transparent; color: var(--text); font: inherit; }
`;

const JS = `'use strict';
// Your own Bit, from the \`bit\` stream: the Bit kit (bit-kit.js) draws it, egg included.
// The stream is pulled: asked for once a second while the widget is on screen.
// The button asks for a move (action category \`bit\`); every Bit on the dashboard does it too.
const bit = XenonBit.mount(document.getElementById('bit'), { label: 'Bit' });
const name = document.getElementById('name');
let light = false;
let last = null;
let pulling = 0;
function pull(on) {
  clearInterval(pulling);
  pulling = 0;
  if (!on) return;
  const ask = () => window.parent.postMessage({ xenonSdk: 1, type: 'refresh', id: Date.now(), stream: 'bit' }, '*');
  ask();
  pulling = setInterval(ask, 1000);
}
function applyTheme(theme) {
  if (!theme) return;
  light = theme.appearance === 'light';
  const root = document.documentElement;
  root.style.colorScheme = light ? 'light' : 'dark';
  const p = theme.palette || {};
  if (p.text) root.style.setProperty('--text', p.text);
  if (p.muted) root.style.setProperty('--muted', p.muted);
  if (last) bit.set(last, { light });
}
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.xenonSdk !== 1) return;
  if (m.type === 'init' || m.type === 'theme') applyTheme(m.theme);
  if (m.type === 'init') pull(true);
  if (m.type === 'visibility') pull(m.visible !== false);
  if (m.type !== 'data' || m.stream !== 'bit' || !m.data) return;
  last = m.data;
  bit.set(last, { light });
  name.textContent = last.hatched ? (last.name || 'Bit') + (last.number ? ' #' + last.number : '') : '';
});
document.getElementById('move').addEventListener('click', () => {
  window.parent.postMessage({ xenonSdk: 1, type: 'action', id: Date.now(), action: { type: 'bitReact', move: 'wave' } }, '*');
});
window.parent.postMessage({ xenonSdk: 1, type: 'hello' }, '*');
`;

/** The starter widget with the person's own Bit, as /sdk/install payload files. */
async function bitFiles({ name, size }) {
  const manifest = {
    api: 1, name, version: '1.0.0', description: 'Your own Bit, live.', size, streams: ['bit'], actions: ['bit'],
  };
  return [
    { path: 'manifest.json', data: b64(JSON.stringify(manifest, null, 2) + '\n') },
    { path: 'index.html', data: b64(HTML) },
    { path: 'style.css', data: b64(CSS) },
    { path: 'main.js', data: b64(JS) },
    { path: KIT, data: b64(await bitKit()) },
  ];
}

// A widget that reads `bit` and has no kit draws nothing: say where the kit comes from.
function bitOf(manifest, files) {
  if (!(manifest?.streams || []).includes('bit')) return {};
  const hasKit = files.some((f) => f && /\.js$/i.test(String(f.path || '')) && fromB64(f.data).includes('globalThis.XenonBit'));
  return hasKit ? {} : {
    bitHint: 'This widget reads the bit stream but carries no Bit kit, so it cannot draw the Bit. Copy bit-kit.js into the package '
      + '(widget_template with bit: true writes one) and load it before your script. See sdk_reference section "bit".',
  };
}

module.exports = { bitFiles, bitOf, KIT };
