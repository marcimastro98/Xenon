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
//   * Never over a voice session, the lock screen, a game or an Ambient scene.
//     It is one of Bit's messages (js/bit-messages.js): a card in the corner that
//     covers nothing, one a day, and only when Xenon is not being used for something.
//
// It is filed before the supporter ask could be: 14 days is under the ask's
// 30, on purpose. Asking someone to show their setup is a smaller thing than
// asking them for money, and it is the one that brings the next person in.
(function () {
  const DAYS_SINCE_FIRST_RUN = 14;
  const DISTINCT_DAYS_USED = 5;
  const CARDS = () => (window.XenonStartupCards || null);
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function daysSince(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return -1;
    const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor((today - then) / 86400000);
  }

  const inviteText = () => t('share_nudge_text',
    'Most people find Xenon in a photo of someone else\'s desk. One tap makes a share card of your dashboard, with a code that leads back here, ready for Reddit, Discord or wherever you post.');

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
    const M = window.BitMessages;
    if (!M) return;
    // Filed once and remembered at once: the message waits for its turn.
    const filed = await M.file([{
      id: 'share:setup',
      kind: 'share',
      surface: 'dashboard',
      title: t('share_nudge_title', 'Show off your setup'),
      line: M.firstLine(inviteText()),
      body: inviteText(),
      action: { type: 'share', label: t('share_nudge_go', 'Create the card') },
    }]);
    if (filed) remember();
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
