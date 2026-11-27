// A home camera in Bit's reply (server/smart-home/camera-look.js, client action `reply_camera`):
// the picture, fetched again every 2 s while it is in sight for five minutes, bigger on a tap
// (js/alerts/door-card.js). Before Bit first looks at a camera for the AI, the same picture
// carries the question: where the picture would go, and three answers that only a tap sends
// (POST /api/home/cameras/consent). Plain markup and events on the document, like
// reply-controls.js: a chat shown in two tiles is a copy of the same HTML.
(() => {
  'use strict';

  // Only the two loopback camera proxies (server/smart-home/routes-cameras.js), never a URL in.
  const PIC = /^\/api\/(?:unifiprotect\/snapshot\/[A-Za-z0-9]{4,64}|ha\/camera\/snapshot\/camera\.[a-z0-9_]{1,120})$/;
  const REFRESH_MS = 2000;
  const LIVE_MS = 5 * 60 * 1000;
  const MAX = 2;
  // Where the AI runs, for the question: a cloud service by its name, a local model as local.
  const SERVICE = {
    gemini: 'Google Gemini', anthropic: 'Anthropic Claude', openai: 'OpenAI',
    claudecode: 'Claude Code (Anthropic)', codex: 'Codex (OpenAI)',
  };
  const LOCAL = new Set(['ollama', 'localapi']);

  let pending = [];
  let timer = null;
  const busy = new WeakSet(); // pictures loading their next frame (never a mark in the copied HTML)

  const say = (key, fallback) => {
    const out = typeof t === 'function' ? t(key) : '';
    return out && out !== key ? out : fallback;
  };
  const base = () => (typeof SERVER === 'string' ? SERVER : '');
  const fresh = (pic) => base() + pic + '?ts=' + Date.now();
  function el(tag, cls, text) {
    const n = Object.assign(document.createElement(tag), { className: cls || '' });
    if (text != null) n.textContent = text;
    return n;
  }

  function askText(provider) {
    if (provider === 'xenon') return say('cam_ask_sparks', 'To say what is there, Bit would send this picture through Xenon\'s service to Anthropic Claude.');
    if (LOCAL.has(provider)) return say('cam_ask_local', 'To say what is there, Bit would look at this picture with the AI on this PC. It does not leave the PC.');
    const service = SERVICE[provider] || say('cam_ask_any', 'the AI you use');
    return say('cam_ask_text', 'To say what is there, Bit would send this picture to {service}.').replace('{service}', service);
  }

  /** @param {{ pic?: string, name?: string, ask?: { provider?: string } }} args */
  function queue(args) {
    const pic = args && typeof args.pic === 'string' && PIC.test(args.pic) ? args.pic : '';
    if (!pic || document.body.classList.contains('ai-voice-mode')) return;
    if (!pending.length) setTimeout(() => { pending = []; }, 0);
    if (pending.length < MAX) {
      const ask = args.ask && typeof args.ask === 'object' ? { provider: String(args.ask.provider || '') } : null;
      pending.push({ pic, name: String(args.name || '').slice(0, 80), ask });
    }
  }

  function build(c) {
    const box = el('div', 'ai-cam');
    box.dataset.pic = c.pic;
    box.dataset.name = c.name;
    box.dataset.until = String(Date.now() + LIVE_MS);
    const shot = el('button', 'ai-cam-shot');
    shot.type = 'button';
    shot.setAttribute('aria-label', say('door_view', 'See it bigger') + (c.name ? ': ' + c.name : ''));
    const img = el('img');
    img.alt = '';
    img.src = fresh(c.pic);
    shot.appendChild(img);
    box.append(shot, el('div', 'ai-cam-name', c.name));
    if (c.ask) box.appendChild(buildAsk(c.ask.provider));
    return box;
  }

  function buildAsk(provider) {
    const ask = el('div', 'ai-cam-ask');
    const row = el('div', 'ai-cam-ask-btns');
    for (const [choice, key, fallback] of [['yes', 'cam_ask_yes', 'Yes, from now on'], ['once', 'cam_ask_once', 'Only this time'], ['no', 'cam_ask_no', 'No, just the picture']]) {
      const b = el('button', 'ai-cam-ask-btn' + (choice === 'yes' ? ' is-primary' : ''), say(key, fallback));
      b.type = 'button';
      b.dataset.camConsent = choice;
      row.appendChild(b);
    }
    if (LOCAL.has(provider)) ask.dataset.local = '1';
    ask.append(el('p', 'ai-cam-ask-text', askText(provider)), row);
    return ask;
  }

  function take(bubble) {
    if (!pending.length || !bubble) return;
    for (const c of pending) bubble.appendChild(build(c));
    pending = [];
    if (!timer) timer = setInterval(refresh, REFRESH_MS);
  }

  // A new frame is loaded aside and swapped in whole, so the picture never blanks. Only what is
  // on screen, in a visible page, inside its five minutes; the timer stops when none is left.
  function refresh() {
    const now = Date.now();
    const live = Array.from(document.querySelectorAll('.ai-cam')).filter((b) => Number(b.dataset.until) > now);
    if (!live.length) { clearInterval(timer); timer = null; return; }
    if (document.hidden) return;
    for (const box of live) {
      const img = box.querySelector('.ai-cam-shot img');
      const r = img?.getBoundingClientRect();
      if (!r || busy.has(img) || !r.width || r.bottom < 0 || r.top > innerHeight) continue;
      busy.add(img);
      const next = new Image();
      next.onload = () => { img.src = next.src; busy.delete(img); };
      next.onerror = () => { busy.delete(img); };
      next.src = fresh(box.dataset.pic);
    }
  }

  // Every copy of the question goes once it is answered, in this tile and its mirrors.
  function settle(pic) {
    for (const a of document.querySelectorAll('.ai-cam-ask')) if (a.closest('.ai-cam')?.dataset.pic === pic) a.remove();
  }

  async function answer(btn) {
    const box = btn.closest('.ai-cam');
    const pic = box?.dataset.pic || '';
    const choice = btn.dataset.camConsent;
    if (choice === 'no') { settle(pic); return; }
    const btns = box.querySelectorAll('.ai-cam-ask-btn');
    btns.forEach((b) => { b.disabled = true; });
    try {
      const res = await fetch(base() + '/api/home/cameras/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice, pic, local: btn.closest('.ai-cam-ask')?.dataset.local === '1' }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed');
      settle(pic);
      if (typeof window.aiAsk === 'function') window.aiAsk(say('cam_go', 'Yes, look at {name}').replace('{name}', box.dataset.name || ''));
    } catch {
      btns.forEach((b) => { b.disabled = false; });
      const text = box.querySelector('.ai-cam-ask-text');
      if (text) text.textContent = say('cam_ask_failed', 'The choice was not saved. Try again.');
    }
  }

  document.addEventListener('click', (e) => {
    const target = e.target && typeof e.target.closest === 'function' ? e.target : null;
    const btn = target?.closest('[data-cam-consent]');
    if (btn) { answer(btn); return; }
    const shot = target?.closest('.ai-cam-shot');
    const box = shot?.closest('.ai-cam');
    if (box && window.DoorCard) window.DoorCard.view(box.dataset.pic, box.dataset.name, { t: typeof t === 'function' ? t : null });
  });

  window.BitCamera = { queue, take };
})();
