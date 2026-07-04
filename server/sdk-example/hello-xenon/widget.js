'use strict';
// Hello Xenon — reference widget for the Xenon widget SDK (API v1).
//
// A widget runs in a sandboxed iframe with NO network access. Everything comes
// from the host over postMessage:
//   1. Send  { xenonSdk: 1, type: 'hello' } once the page is ready.
//   2. Receive 'init'  → { api, theme, lang, streams, actions } (what you were granted).
//   3. Receive 'data'  → { stream, data } for each granted stream, as it updates.
//   4. Receive 'theme' → { theme } when the dashboard theme changes.
//   5. Send 'action'   → { id, action } (a granted category); the host replies
//      with 'action_result' → { id, ok, error }.
// Full protocol reference: docs/WIDGET_SDK.md in the Xenon repository.
(function () {
  const $ = (id) => document.getElementById(id);
  let reqId = 0;

  function send(msg) {
    window.parent.postMessage({ xenonSdk: 1, ...msg }, '*');
  }

  function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement;
    root.style.setProperty('--accent', theme.accent || '#1ed760');
    root.style.setProperty('--bg', theme.background || '#070808');
    root.style.setProperty('--text', theme.text || '#f0f3f1');
    root.dataset.appearance = theme.appearance === 'light' ? 'light' : 'dark';
  }

  function onSystem(d) {
    if (!d || typeof d !== 'object') return;
    const pct = (v) => (Number.isFinite(Number(v)) && v !== null ? Math.round(Number(v)) + '%' : '--%');
    $('cpu').textContent = pct(d.cpu);
    $('gpu').textContent = pct(d.gpu);
    $('ram').textContent = pct(d.memory && d.memory.percent);
  }

  function onMedia(d) {
    if (!d || typeof d !== 'object') return;
    // Untrusted-by-convention: always textContent, never innerHTML.
    const title = typeof d.title === 'string' ? d.title : '';
    const artist = typeof d.artist === 'string' ? d.artist : '';
    $('track').textContent = title ? (artist ? artist + ' — ' + title : title) : 'Nothing playing';
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object' || m.xenonSdk !== 1) return;
    if (m.type === 'init') {
      applyTheme(m.theme);
    } else if (m.type === 'theme') {
      applyTheme(m.theme);
    } else if (m.type === 'data') {
      if (m.stream === 'system') onSystem(m.data);
      else if (m.stream === 'media') onMedia(m.data);
    }
    // 'action_result' could drive per-key feedback; the demo keeps it simple.
  });

  function mediaKey(cmd) {
    send({ type: 'action', id: ++reqId, action: { type: 'media', cmd } });
  }
  $('prev').addEventListener('click', () => mediaKey('previous'));
  $('play').addEventListener('click', () => mediaKey('playpause'));
  $('next').addEventListener('click', () => mediaKey('next'));

  function tick() {
    const now = new Date();
    $('clock').textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  }
  tick();
  setInterval(tick, 5000);

  send({ type: 'hello' });
})();
