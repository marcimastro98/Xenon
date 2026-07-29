'use strict';
// Call modal — the card that opens when the phone rings.
//
// The server (calls.js) owns the ring: what is ringing, who from, and — this is
// the part that shapes the whole UI — which buttons are REAL on this machine.
// Every call carries a `caps` object, and this module renders exactly the
// buttons it says true for. It never guesses, never draws a hopeful Answer, and
// where nothing can be done it says what the user can do instead.
//
// That is not defensive coding for its own sake: answering is a real API call
// for Discord, a focus-plus-shortcut for Teams and Zoom, and genuinely
// impossible for a mirrored phone call. A single button that behaves in three
// ways and sometimes in none would be the worst version of this feature.
//
// Everything on the card is untrusted text — a caller's name and an app's own
// notification wording — so it all goes through textContent, and an icon is
// rendered only when its URL scheme is one we allow.
(function () {
  const S = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    phone: S('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>'),
    hangup: S('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" transform="rotate(135 12 12)"/>'),
    video: S('<path d="m23 7-7 5 7 5V7Z"/><rect x="1" y="5" width="15" height="14" rx="2"/>'),
    bellOff: S('<path d="M8.7 3a6 6 0 0 1 9.3 5c0 3.5.7 5.7 1.5 7.1M6.3 6.3C6.1 6.8 6 7.4 6 8c0 7-3 9-3 9h14"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="m2 2 20 20"/>'),
    open: S('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    app: S('<rect x="3" y="3" width="18" height="18" rx="4"/>'),
  };

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;    // shared DOM factory from utils.js
  const api = apiJson;  // shared fetch-JSON helper from utils.js

  let list = [];             // ringing calls, newest first (server order)
  let overlay = null;
  let freezeToken = '';
  let busy = '';             // the action in flight, so a double tap cannot double-answer
  let problem = '';          // the last failure, shown on the card
  let seeded = false;

  function callsCfg() {
    try {
      const c = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.calls : null;
      return c && typeof c === 'object' ? c : {};
    } catch { return {}; }
  }

  // An icon URL is rendered only when its scheme is one we allow. A notification
  // icon is a data: image minted by the server's own reader, and a Discord one
  // is an https URL it validated — anything else is dropped rather than shown,
  // because this string reaches an <img src>.
  function safeIcon(url) {
    const s = String(url || '');
    if (s.startsWith('data:image/')) return s;
    if (/^https:\/\//i.test(s)) return s;
    return '';
  }

  // Initials for the avatar. Only letters and digits count as a word: people
  // put emoji in contact names ("Amore 🐔"), and taking the emoji as a second
  // initial filled the circle with a picture instead of a letter. \p{L} keeps
  // Cyrillic, Greek and CJK working — it is emoji and punctuation that are
  // excluded, not non-Latin scripts.
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/)
      .map(w => Array.from(w).filter(ch => /[\p{L}\p{N}]/u.test(ch)).join(''))
      .filter(Boolean);
    if (!parts.length) return '';
    const first = Array.from(parts[0])[0] || '';
    const second = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] || '') : '';
    return (first + second).toUpperCase();
  }

  // ── acting ────────────────────────────────────────────────────────────────

  async function act(call, action) {
    if (busy) return;
    busy = action;
    problem = '';
    paint();
    let r = null;
    try {
      r = await api('/api/calls/act', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: call.id, action }),
      });
    } catch { r = null; }
    busy = '';
    if (!r || r.ok !== true) {
      // Never silently: the whole promise of this card is that a tap does
      // something, so a tap that did not has to say so and leave the call up.
      problem = errorText((r && r.error) || 'failed');
      paint();
      return;
    }
    // Success removes the call server-side and the broadcast repaints us; the
    // local prune just avoids a frame of stale card on a slow link.
    if (action !== 'silence') list = list.filter(c => c.id !== call.id);
    paint();
  }

  function errorText(code) {
    const map = {
      window_not_found: t('call_err_window', 'I could not find that app’s window.'),
      no_window_tool: t('call_err_window', 'I could not find that app’s window.'),
      window_list_failed: t('call_err_window', 'I could not find that app’s window.'),
      hotkey_unavailable: t('call_err_keys', 'This machine cannot send the shortcut.'),
      hotkey_failed: t('call_err_keys', 'This machine cannot send the shortcut.'),
      accessibility_denied: t('call_err_access', 'Allow Xenon Helper under Accessibility to answer from here.'),
      discord_unavailable: t('call_err_discord', 'Discord is not connected.'),
      discord_failed: t('call_err_discord', 'Discord is not connected.'),
      not_ringing: t('call_err_gone', 'That call is no longer ringing.'),
      unavailable: t('call_err_unavailable', 'That is not possible on this PC.'),
    };
    return map[code] || t('call_err_generic', 'It did not work.');
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function button(cls, icon, label, onClick, opts) {
    const o = opts || {};
    const b = el('button', 'call-btn' + (cls ? ' ' + cls : '') + (o.on ? ' is-on' : ''));
    b.type = 'button';
    const ico = el('span', 'call-btn-ico');
    ico.innerHTML = icon;                     // static, trusted SVG
    b.append(ico, el('span', 'call-btn-label', label));
    if (o.disabled) b.disabled = true;
    else b.addEventListener('click', onClick);
    return b;
  }

  function card(call) {
    const c = el('div', 'call-card' + (call.silenced ? ' is-silenced' : ''));

    // Remaining ring. Driven by the server's own endsAt so every surface agrees,
    // and set inline because the duration is data, not a design constant.
    const life = el('div', 'call-life');
    const fill = el('div', 'call-life-fill');
    const left = Math.max(0, (Number(call.endsAt) || 0) - Date.now());
    const total = Math.max(1, (Number(call.endsAt) || 0) - (Number(call.at) || 0));
    fill.style.animationDuration = Math.round(left) + 'ms';
    fill.style.animationDelay = '0ms';
    fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, left / total)) + ')';
    life.appendChild(fill);
    c.appendChild(life);

    // Which app is ringing.
    const app = el('div', 'call-app');
    const appIco = el('span', 'call-app-ico');
    const iconUrl = safeIcon(call.icon);
    if (iconUrl) {
      const img = document.createElement('img');
      img.alt = ''; img.src = iconUrl;
      // An icon URL that 404s or is blocked leaves an empty grey box, which
      // reads as a broken card rather than as a missing picture — seen on a
      // real Discord ring, whose avatar URL did not resolve. Fall back to the
      // generic glyph the no-icon case already uses.
      img.addEventListener('error', () => { appIco.innerHTML = ICONS.app; }, { once: true });
      appIco.appendChild(img);
    } else {
      appIco.innerHTML = ICONS.app;           // static SVG
    }
    app.append(appIco, el('span', '', call.appName || ''));
    c.appendChild(app);

    // Who.
    const avatar = el('div', 'call-avatar');
    avatar.textContent = initials(call.caller) || '';
    c.appendChild(avatar);

    const who = el('div', 'call-who');
    who.appendChild(el('div', 'call-name', call.caller || t('call_unknown', 'Unknown number')));
    const detail = call.video
      ? t('call_incoming_video', 'Incoming video call')
      : (call.detail || t('call_incoming', 'Incoming call'));
    who.appendChild(el('div', 'call-detail', detail));
    c.appendChild(who);

    // What can actually be done about it, in two rows. The split is the
    // hierarchy: the first row is the decision, the second is what you do
    // instead of deciding. Four equal buttons read as four equal choices.
    const caps = call.caps || {};
    const stack = el('div', 'call-stack');
    const actions = el('div', 'call-actions');
    if (caps.answer) {
      actions.appendChild(button('call-btn--answer', call.video ? ICONS.video : ICONS.phone,
        busy === 'answer' ? t('call_answering', 'Answering…') : t('call_answer', 'Answer'),
        () => act(call, 'answer'), { disabled: !!busy }));
    }
    if (caps.decline) {
      actions.appendChild(button('call-btn--decline', ICONS.hangup, t('call_decline', 'Decline'),
        () => act(call, 'decline'), { disabled: !!busy }));
    }
    if (actions.childElementCount) stack.appendChild(actions);

    const minor = el('div', 'call-actions call-actions--minor');
    minor.appendChild(button('', ICONS.bellOff,
      call.silenced ? t('call_silenced', 'Silenced') : t('call_silence', 'Silence'),
      () => act(call, 'silence'), { disabled: !!busy || !!call.silenced, on: !!call.silenced }));
    if (caps.open) {
      minor.appendChild(button('', ICONS.open, t('call_open', 'Open app'),
        () => act(call, 'open'), { disabled: !!busy }));
    }
    // When nothing can be answered, the minor row IS the row of real choices, so
    // it takes the full presentation rather than looking like a footnote.
    if (!actions.childElementCount) minor.classList.remove('call-actions--minor');
    stack.appendChild(minor);
    c.appendChild(stack);

    // The honest line. Shown only when this machine cannot answer, and it names
    // the reason rather than leaving a hole where a button should be.
    if (!caps.answer) {
      const why = call.source === 'discord'
        ? t('call_note_discord', 'Connect Discord in Settings to answer from here.')
        : t('call_note_open', 'This app cannot be answered from Xenon. Open it to pick up.');
      c.appendChild(el('div', 'call-note', why));
    } else if (call.source === 'discord' && !caps.decline) {
      c.appendChild(el('div', 'call-note', t('call_note_nodecline', 'Discord does not allow declining from outside the app.')));
    }

    if (problem) c.appendChild(el('div', 'call-note', problem));

    if (list.length > 1) {
      c.appendChild(el('div', 'call-more', t('call_more', 'Another call is waiting')
        .replace('{n}', String(list.length - 1))));
    }

    const dismiss = el('button', 'call-dismiss', t('call_dismiss', 'Dismiss'));
    dismiss.type = 'button';
    dismiss.addEventListener('click', () => act(call, 'dismiss'));
    c.appendChild(dismiss);

    return c;
  }

  function paint() {
    const call = list[0] || null;

    if (!call) {
      closeOverlay();
      return;
    }
    if (!overlay) {
      overlay = el('div', 'call-overlay');
      document.body.appendChild(overlay);
      // Freeze the dashboard behind the blur. This is the case the freeze
      // machinery exists for: a full-viewport backdrop-filter over a moving
      // dashboard re-blurs every frame, and nothing behind this card is being
      // looked at. The ring's own pulse deliberately does NOT opt into the
      // freeze — see CallModal.css.
      freezeToken = 'call:' + call.id;
      if (typeof window.ambientFreeze === 'function') window.ambientFreeze(freezeToken, true);
    }
    overlay.replaceChildren(card(call));
    // The ring follows the card: it sounds while something is ringing and not
    // silenced, and stops the moment either changes. Asking on every paint
    // rather than tracking transitions keeps the two from drifting apart.
    ring(!call.silenced && callsCfg().sound !== false);
  }

  function ring(on) {
    try { if (window.XenonSound && typeof window.XenonSound.ring === 'function') window.XenonSound.ring(!!on); }
    catch { /* audio is optional; the card is the real surface */ }
  }

  function closeOverlay() {
    ring(false);
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    if (freezeToken && typeof window.ambientFreeze === 'function') window.ambientFreeze(freezeToken, false);
    freezeToken = '';
    problem = '';
  }

  // ── inputs ────────────────────────────────────────────────────────────────

  // SSE 'calls' — the whole ringing list, replaced wholesale. Wholesale because
  // a card that is out of step with the server is worse than one that repaints:
  // the server is the only thing that knows a call was answered on another
  // surface, and it says so by sending a list without it.
  function onCalls(data) {
    if (!data || typeof data !== 'object') return;
    list = Array.isArray(data.calls) ? data.calls : [];
    if (!list.length) problem = '';
    paint();
  }

  // A dashboard that opens mid-ring must show the card. The SSE seed covers the
  // normal path; this covers a surface that loads without one (and costs one
  // request, only when the feature is on).
  async function seed() {
    if (seeded) return;
    seeded = true;
    if (callsCfg().enabled !== true) return;
    try {
      const d = await api('/api/calls');
      if (d && Array.isArray(d.calls) && d.calls.length) onCalls({ calls: d.calls });
    } catch { /* the stream will bring it */ }
  }

  // The card closes itself when the ring would have ended. The server expires it
  // too and broadcasts, but only while a dashboard is connected — this keeps the
  // two in step on a surface whose stream dropped, so a card can never sit there
  // ringing forever after the caller gave up.
  setInterval(() => {
    if (!list.length) return;
    const now = Date.now();
    const before = list.length;
    list = list.filter(c => (Number(c.endsAt) || 0) > now);
    if (list.length !== before) paint();
  }, 1000);

  document.addEventListener('DOMContentLoaded', seed);
  if (document.readyState !== 'loading') seed();

  window.CallModal = { onCalls, seed };
})();
