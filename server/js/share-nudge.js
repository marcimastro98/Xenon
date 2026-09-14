'use strict';

// ── The one-time "show off your setup" invitation ───────────────────────────
//
// Xenon has had a share card since 4.10 — a composed PNG of the dashboard with
// a QR code that leads back to the site — and it lives behind a button in
// Settings, so the people who would post it never learn it exists. The numbers
// say that matters more than anything else on the growth side: one photo of a
// desk with Xenon on it did ten times the reach of every post about the
// product, and the person who posted it was not the author. Users are the
// distribution. This invites them, once.
//
// It follows every rule the supporter ask (js/support-card.js) follows, for
// the same reasons, and the tests pin them:
//
//   * ONCE in the life of an install. The flag is in hub settings, on disk,
//     never in localStorage, so a browser that clears its site data does not
//     bring it back.
//   * Only after 14 days AND 5 separate days of use. Someone who has opened
//     the dashboard on five different days over two weeks has a setup worth
//     showing; before that it is a default layout and the card would be
//     asking a stranger to advertise.
//   * Never over a voice session, the lock screen, a game or an Ambient scene,
//     and never on a boot where another startup card is already up. It waits
//     for the next day instead.
//   * No modal, no sound, nothing blocked. Same shell, same corner, same
//     motion as the Discord invite and the supporter ask.
//
// It never opens before the supporter ask could: 14 days is under the ask's
// 30, on purpose. Asking someone to show their setup is a smaller thing than
// asking them for money, and it is the one that brings the next person in.
(function () {
  const DAYS_SINCE_FIRST_RUN = 14;
  const DISTINCT_DAYS_USED = 5;
  // Later than both other cards (Discord 1400ms, support 4200ms): by then a
  // card that was due today is already on screen, and this one steps back.
  const SHOW_AFTER_MS = 7000;

  const CARDS = () => (window.XenonStartupCards || null);
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  // A camera, drawn to sit on the same disc the other cards use.
  const CAMERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.4-2h5.2L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.4"/></svg>';
  const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function daysSince(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return -1;
    const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor((today - then) / 86400000);
  }

  // The moments Xenon is being used for something. Same body-class convention
  // the toast system's do-not-disturb and the supporter ask already read.
  function busyRightNow() {
    try {
      const c = document.body.classList;
      return c.contains('lock-screen-active')
        || c.contains('ai-voice-mode') || c.contains('ai-listening')
        || c.contains('game-mode') || c.contains('ambient-scene-open')
        || c.contains('ambient-canvas-open');
    } catch { return true; }   // cannot tell → do not interrupt
  }

  // Never two cards in the corner. The others arrive earlier on the same boot,
  // so by SHOW_AFTER_MS either is already there or is not coming today.
  function anotherCardUp() {
    return !!(document.getElementById('support-ask') || document.getElementById('discord-invite'));
  }

  function showCard() {
    if (document.getElementById('share-nudge')) return;
    const card = document.createElement('div');
    card.className = 'discord-invite share-nudge';   // same shell, same corner, same motion
    card.id = 'share-nudge';
    card.setAttribute('role', 'complementary');
    card.setAttribute('aria-label', t('share_nudge_title', 'Show off your setup'));

    const head = document.createElement('div');
    head.className = 'discord-invite-head';
    const logo = document.createElement('div');
    logo.className = 'discord-invite-logo share-nudge-logo';
    logo.innerHTML = CAMERA;               // static, trusted markup
    const title = document.createElement('div');
    title.className = 'discord-invite-title';
    title.textContent = t('share_nudge_title', 'Show off your setup');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'discord-invite-close';
    close.setAttribute('aria-label', t('close', 'Close'));
    close.innerHTML = CLOSE;               // static, trusted markup
    // The × is final too: once per install means once, whichever way it ends.
    close.addEventListener('click', () => { remember(); hide(); });
    head.append(logo, title, close);

    const text = document.createElement('p');
    text.className = 'discord-invite-text';
    text.textContent = t('share_nudge_text',
      'Most people find Xenon in a photo of someone else\'s desk. One tap makes a share card of your dashboard, with a code that leads back here, ready for Reddit, Discord or wherever you post.');

    const actions = document.createElement('div');
    actions.className = 'discord-invite-actions';

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'discord-invite-join';
    go.textContent = t('share_nudge_go', 'Create the card');
    go.addEventListener('click', () => {
      remember();
      hide();
      try {
        if (window.ShareCard && typeof window.ShareCard.open === 'function') window.ShareCard.open({ source: 'setup' });
      } catch { /* the card composer reports its own failures */ }
    });

    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'discord-invite-dismiss';
    later.textContent = t('share_nudge_later', 'Not now');
    later.addEventListener('click', () => { remember(); hide(); });

    actions.append(go, later);
    card.append(head, text, actions);
    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add('is-in'));
  }

  function hide() {
    const card = document.getElementById('share-nudge');
    if (!card) return;
    card.classList.remove('is-in');
    setTimeout(() => { card.remove(); }, 320);
  }

  function remember() {
    const c = CARDS();
    if (c && typeof c.rememberShareNudge === 'function') c.rememberShareNudge();
  }

  async function maybeShow() {
    const c = CARDS();
    if (!c || typeof c.shareNudgeDismissed !== 'function') return;
    if (c.shareNudgeDismissed()) return;
    // Nothing to invite anyone to without the composer on this page.
    if (!window.ShareCard || typeof window.ShareCard.open !== 'function') return;
    const use = typeof c.usageHistory === 'function' ? c.usageHistory() : null;
    if (!use) return;                                   // server copy not in yet
    if (daysSince(use.firstRunDay) < DAYS_SINCE_FIRST_RUN) return;
    if (use.usageDays < DISTINCT_DAYS_USED) return;
    setTimeout(() => {
      if (busyRightNow()) return;
      if (anotherCardUp()) return;
      if (c.shareNudgeDismissed()) return;
      showCard();
    }, SHOW_AFTER_MS);
  }

  function init() {
    const c = CARDS();
    if (c && typeof c.whenReady === 'function') c.whenReady(() => { maybeShow(); });
    else maybeShow();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
