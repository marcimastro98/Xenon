'use strict';
// Runs right after demo/boot.js: answers the scene adds on top of the public
// demo's (window.__SHOT__.answers, by path) and live events it pushes on every
// demo stream (window.__SHOT__.events, by event type, again each second so
// moving tiles keep moving).
(function () {
  const shot = window.__SHOT__ || {};
  const answers = shot.answers || {};
  const events = shot.events || {};
  const demoFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin === location.origin && Object.hasOwn(answers, url.pathname)) {
      return Promise.resolve(new Response(JSON.stringify(answers[url.pathname]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return demoFetch.apply(this, arguments);
  };

  const DemoSource = window.EventSource;
  const types = Object.keys(events);
  function ShotSource(url) {
    const s = new DemoSource(url);
    if (types.length) {
      const push = () => { if (s.readyState !== 2) types.forEach((t) => s._emit(t, typeof events[t] === 'function' ? events[t]() : events[t])); };
      setTimeout(push, 300);
      const id = setInterval(() => (s.readyState === 2 ? clearInterval(id) : push()), 1000);
    }
    return s;
  }
  ShotSource.prototype = DemoSource.prototype;
  ShotSource.CONNECTING = 0; ShotSource.OPEN = 1; ShotSource.CLOSED = 2;
  window.EventSource = ShotSource;
})();
