'use strict';

// Bit in the chat tile: the live Bit in each chat pane's head (the primary and
// every duplicated copy), its mood following the turn, the still Bit beside
// each reply, the way to more Scintille when they run low, and the attach menu
// (a file, or the screen). ai.js owns the session; this file only shows it.
// A reply shows no Scintille spent: the head's balance follows on its own, and
// a number next to "Annulla" read like a refund (30 Oct 2026).
(function () {
  const AVATAR_PX = 18;
  // setAiStatus() states -> the mood Bit loops while the chat is in it.
  const STATUS_MOOD = { thinking: 'think', connecting: 'think', working: 'work', listening: 'listen', error: 'worry' };
  // A reply's mood -> the pose beside it: done is Bit happy, in the done colour.
  const REPLY_POSE = { idle: ['idle'], done: ['happy', 'done'], worry: ['worry'] };

  const tr = (k) => (typeof t === 'function' ? t(k) : k);
  const heads = () => document.querySelectorAll('[data-dashboard-widget="chat"] [data-chatf="bit"]');

  // Every chat pane gets its live Bit; a copy made later is picked up on the
  // next sync (mirrorChatCopies calls this).
  function mountHeads() {
    if (!window.BitApp) return;
    heads().forEach((host) => BitApp.mount(host, { mood: 'idle' }));
    BitApp.sweep();
  }

  function eachPlayer(fn) {
    if (!window.BitApp) return;
    heads().forEach((host) => {
      const p = BitApp.playerFor(host);
      if (p) fn(p);
    });
  }

  function setStatus(state) {
    const mood = STATUS_MOOD[state] || 'idle';
    eachPlayer((p) => p.setMood(mood));
  }

  // One clip on every head Bit, then back to its mood. Played after the
  // current task, so the status reset that closes a turn does not cut it.
  function react(clipId) {
    queueMicrotask(() => eachPlayer((p) => { p.play(clipId); }));
  }

  // The still Bit beside a reply, as markup (the chat mirrors copy HTML).
  function avatarHtml(mood) {
    if (!window.BitApp) return '';
    const [clipId, tint] = REPLY_POSE[mood] || REPLY_POSE.idle;
    const svg = BitApp.still(clipId, AVATAR_PX, tint);
    return svg ? `<span class="ai-msg-bit" aria-hidden="true">${svg}</span>` : '';
  }

  // The way to more Scintille, in the chat at the moment they are needed: under
  // the reply that took the balance below the low mark (once, when it crosses it,
  // never on every reply after) and under the turn refused for an empty balance.
  // The button opens the Store's Sparks tab, where the packs are sold; its own
  // class, because a .ai-choice would be sent as a message.
  function buyRow(text) {
    if (!window.XenonCredits || !XenonCredits.openShop) return null;
    const row = document.createElement('div');
    row.className = 'ai-buy';
    if (text) {
      const words = document.createElement('p');
      words.className = 'ai-buy-line';
      words.textContent = text;
      row.append(words);
    }
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'ai-buy-pack ai-buy-go';
    if (XenonCredits.offerMark) go.append(XenonCredits.offerMark());
    const label = document.createElement('span');
    label.textContent = tr('sparks_buy_more');
    go.append(label);
    go.addEventListener('click', () => XenonCredits.openShop());
    row.append(go);
    return row;
  }

  function crossedLow(before, after) {
    if (!window.XenonCredits || !Number.isFinite(before) || !Number.isFinite(after)) return false;
    return before >= XenonCredits.LOW_CREDITS && after < XenonCredits.LOW_CREDITS;
  }

  // ── Bit in voice mode ───────────────────────────────────────────────
  // This Bit lives on the voice overlay, which is the thing in front, so the
  // dashboard freezes are not its hold: only the low-GPU choices (and reduced
  // motion, in the engine) stand it still. Hidden, it stops by itself.
  const VOICE_HOLD = ['low-power-gpu', 'perf-mode'];
  const VOICE_MOOD = { connecting: 'think', thinking: 'think', listening: 'listen', speaking: 'talk' };

  function voiceState(state) {
    const host = document.querySelector('[data-voice-bit]');
    if (!host || !window.BitApp) return;
    const player = BitApp.mount(host, { mood: 'listen', fidgets: false, hold: VOICE_HOLD });
    const mood = VOICE_MOOD[state] || 'idle';
    if (player) player.setMood(mood);
    // The halo and the bars take the colour of the mood.
    const rgb = window.Xenon && Xenon.bit && Xenon.bit.rgb(mood);
    const view = host.closest('.ai-voice-view');
    if (view && rgb) view.style.setProperty('--bit-rgb', rgb);
  }

  // ── The top bar launcher is Bit ─────────────────────────────────────
  // Painted once, before the phone dock is built: the dock copies this icon.
  // A still glyph in the button's ink, so it reads on any accent and costs
  // nothing next to the button's own shimmer.
  function paintLauncher() {
    const btn = document.querySelector('.topbtn-xenon');
    const svg = btn && window.BitApp ? BitApp.glyph('idle') : '';
    if (!svg) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = svg;
    const bit = tpl.content.firstElementChild;
    bit.setAttribute('aria-hidden', 'true');
    bit.classList.add('topbtn-bit');
    const old = btn.querySelector('svg');
    if (old) old.replaceWith(bit);
    else btn.prepend(bit);
  }

  // ── Attach menu: a file, or the screen on every message ─────────────
  function closeAttachMenu() {
    document.querySelectorAll('.ai-attach-menu').forEach((m) => m.remove());
    document.querySelectorAll('.ai-attach-btn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }

  function attachItem(label, onPick, pressed) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-attach-item';
    b.setAttribute('role', 'menuitem');
    if (pressed != null) b.setAttribute('aria-checked', String(!!pressed));
    if (pressed != null) b.setAttribute('role', 'menuitemcheckbox');
    b.textContent = label;
    b.addEventListener('click', () => { closeAttachMenu(); onPick(); });
    return b;
  }

  function toggleAttachMenu(btn) {
    const open = btn.getAttribute('aria-expanded') === 'true';
    closeAttachMenu();
    if (open) return;
    const menu = document.createElement('div');
    menu.className = 'ai-attach-menu';
    menu.setAttribute('role', 'menu');
    const screenOn = typeof _aiScreenMode !== 'undefined' && _aiScreenMode;
    menu.append(
      attachItem(tr('bit_attach_file'), () => aiAttachImage()),
      attachItem(tr(screenOn ? 'bit_attach_screen_off' : 'bit_attach_screen'), () => aiCaptureScreen(), screenOn),
    );
    btn.setAttribute('aria-expanded', 'true');
    btn.parentElement.insertBefore(menu, btn.nextSibling);
    const first = menu.querySelector('button');
    if (first) first.focus();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.ai-attach-btn');
    if (btn) { e.preventDefault(); toggleAttachMenu(btn); return; }
    if (!(e.target && e.target.closest && e.target.closest('.ai-attach-menu'))) closeAttachMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAttachMenu(); });

  paintLauncher();

  window.BitChat = { mountHeads, setStatus, react, avatarHtml, buyRow, crossedLow, closeAttachMenu, voiceState };
})();
