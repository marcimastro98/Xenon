// The live feed (`/sse`) of the app's own windows, carried on a WebSocket.
//
// A browser keeps at most 6 HTTP/1.1 connections per host and profile, and an
// EventSource holds one for as long as its page lives. The app opens one page
// per surface: the alerts window, each desktop and overlay surface, the animated
// wallpaper on every screen, the menu. Six of those and every other request from
// that profile waits forever: pictures stay blank and buttons do nothing, with no
// error anywhere. WebSockets have no such limit, so inside the app `EventSource`
// on `/sse` is this class, with the same behaviour and the same frames. Pages keep
// writing `new EventSource('/sse')`, and a plain browser or a phone is untouched.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.install(root);
}(typeof self !== 'undefined' ? self : this, () => {
  const SOCKET_PATH = '/sse/socket';
  const RETRY_MIN_MS = 1000;
  const RETRY_MAX_MS = 8000;
  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSED = 2;

  // One `event:`/`data:` block per entry; comments (`:ping`) yield nothing.
  function parseFrames(text) {
    const frames = [];
    for (const block of String(text).split('\n\n')) {
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) frames.push({ event, data: data.join('\n') });
    }
    return frames;
  }

  function isLiveFeed(url, origin) {
    try {
      const u = new URL(String(url), origin);
      return u.origin === origin && u.pathname === '/sse';
    } catch (e) {
      return false;
    }
  }

  function socketUrl(origin) {
    return origin.replace(/^http/, 'ws') + SOCKET_PATH;
  }

  function create(env) {
    class SocketStream extends EventTarget {
      constructor(url) {
        super();
        this.url = String(url);
        this.readyState = CONNECTING;
        this.withCredentials = false;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this._names = new Set();
        this._opened = false;
        this._retryMs = RETRY_MIN_MS;
        this._retry = null;
        this._socket = null;
        this._plain = null;
        this._connect();
      }

      addEventListener(name, fn, options) {
        this._names.add(name);
        super.addEventListener(name, fn, options);
        if (this._plain) this._relay(name);
      }

      close() {
        this.readyState = CLOSED;
        clearTimeout(this._retry);
        if (this._plain) this._plain.close();
        if (this._socket) this._socket.close();
      }

      _emit(name, event) {
        this.dispatchEvent(event);
        const handler = this[`on${name}`];
        if (typeof handler === 'function') handler.call(this, event);
      }

      _connect() {
        const socket = new env.WebSocket(socketUrl(env.origin));
        this._socket = socket;
        socket.onopen = () => {
          this._opened = true;
          this._retryMs = RETRY_MIN_MS;
          this.readyState = OPEN;
          this._emit('open', new Event('open'));
        };
        socket.onmessage = (e) => {
          for (const { event, data } of parseFrames(e.data)) {
            this._emit(event, new MessageEvent(event, { data }));
          }
        };
        socket.onclose = () => this._dropped();
      }

      _dropped() {
        this._socket = null;
        if (this.readyState === CLOSED) return;
        // Refused before it ever opened: this server has no socket to offer.
        if (!this._opened) { this._usePlain(); return; }
        this.readyState = CONNECTING;
        this._emit('error', new Event('error'));
        this._retry = setTimeout(() => this._connect(), this._retryMs);
        this._retryMs = Math.min(this._retryMs * 2, RETRY_MAX_MS);
      }

      _usePlain() {
        const plain = new env.EventSource(this.url);
        this._plain = plain;
        plain.onopen = () => { this.readyState = OPEN; this._emit('open', new Event('open')); };
        plain.onerror = () => { this.readyState = plain.readyState; this._emit('error', new Event('error')); };
        for (const name of this._names) this._relay(name);
      }

      _relay(name) {
        if (name === 'open' || name === 'error') return;
        this._plain.addEventListener(name, (e) => {
          this._emit(name, new MessageEvent(name, { data: e.data }));
        });
      }
    }

    function LiveEventSource(url, init) {
      if (!isLiveFeed(url, env.origin)) return new env.EventSource(url, init);
      return new SocketStream(url);
    }
    LiveEventSource.CONNECTING = CONNECTING;
    LiveEventSource.OPEN = OPEN;
    LiveEventSource.CLOSED = CLOSED;
    return LiveEventSource;
  }

  // Only in the app's windows, which are the ones that open many pages at once.
  function install(win) {
    if (win.__XENON_NATIVE__ !== true || typeof win.WebSocket !== 'function') return;
    if (typeof win.EventSource !== 'function') return;
    win.EventSource = create({
      WebSocket: win.WebSocket,
      EventSource: win.EventSource,
      origin: win.location.origin,
    });
  }

  return { create, install, isLiveFeed, parseFrames, socketUrl };
}));
