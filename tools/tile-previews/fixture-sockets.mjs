// Page code for the two tiles fed through a WebSocket: Twitch chat (IRC lines) and the
// embedded browser (the relay's frames). The demo installs its own dead socket at boot,
// so the hook sits on window.WebSocket before that and keeps whatever the demo assigns.
// A plain function, turned into text by socketScript: it runs in the page, never here.

function installSockets({ lines, relay }) {
  const JPEG_QUALITY = 0.9;
  let Demo = window.WebSocket;

  const picture = async (src, w, h) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
  };

  const relaySocket = () => {
    const listeners = {};
    const emit = (kind, event) => (listeners[kind] || []).forEach((fn) => fn(event));
    const say = (body) => emit('message', { data: JSON.stringify(body) });
    const socket = {
      readyState: 0,
      addEventListener: (kind, fn) => { (listeners[kind] = listeners[kind] || []).push(fn); },
      close() {},
      async send(raw) {
        const m = JSON.parse(raw);
        if (m.type !== 'open' && m.type !== 'resize') return;
        say({ type: 'nav', tile: m.tile, url: relay.url });
        say({ type: 'frame', tile: m.tile, data: await picture(relay.image, m.w, m.h), meta: { deviceWidth: m.w, deviceHeight: m.h } });
      },
    };
    setTimeout(() => { socket.readyState = 1; emit('open', {}); }, 300);
    return socket;
  };

  function FixtureSocket(url, protocols) {
    const target = String(url);
    if (relay && target.includes('/embedded-browser/ws')) return relaySocket();
    const socket = new Demo(url, protocols);
    const host = Object.keys(lines).find((name) => target.includes(name));
    if (host) setTimeout(() => socket.onmessage && socket.onmessage({ data: lines[host] }), 300);
    return socket;
  }
  Object.assign(FixtureSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  Object.defineProperty(window, 'WebSocket', { configurable: true, get: () => FixtureSocket, set: (value) => { Demo = value; } });
}

// '' when the fixture has no socket to feed, so other tiles keep the demo's own.
export function socketScript({ sockets, relay }) {
  if (!sockets && !relay) return '';
  return `(${installSockets})(${JSON.stringify({ lines: sockets || {}, relay: relay || null })});`;
}
