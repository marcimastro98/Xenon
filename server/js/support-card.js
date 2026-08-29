'use strict';

// ── The one-time supporter ask ─────────────────────────────────────────────
//
// Xenon has had a donate button since the beginning, in the app, on the site, on
// GitHub and on Discord. It has never ASKED, so only people who went looking
// ever found it. This asks, once, and then never again.
//
// The rules it lives by are the whole design, and each one is a decision:
//
//   * ONCE in the life of an install. Not once a month, not once a version. The
//     flag lives in hub settings — on disk — and not in localStorage, because a
//     browser set to clear its site data would otherwise put this back every few
//     weeks, which is the difference between an ask and a nag.
//   * Only after 30 days AND 10 separate days of use. Someone who has opened
//     Xenon on ten different days over a month has decided it is useful; anyone
//     earlier is still deciding, and asking them is asking a stranger for money.
//   * Never to somebody who already supports the project. If a supporter pass is
//     saved on this machine, this never appears at all.
//   * Never over a voice session, the lock screen, a game or an Ambient scene.
//     Those are the moments Xenon is being USED for something, and a card that
//     interrupts them earns the opposite of goodwill. It waits for the next day
//     instead — the gate simply does not pass today.
//   * No modal, no sound, no autoplay, nothing blocked. It is the same card the
//     Discord invite uses, in the same corner, dismissed the same way.
//
// The wording leads with the monthly option on purpose. The existing framing is
// "buy me a coffee", which is a one-off by its nature; recurring support is what
// makes a project sustainable, and nobody was being offered it.
//
// It also carries a third button, "I already support Xenon", which is not
// politeness: the supporter check below can only see a pass that was REDEEMED in
// the app, so a supporter who never claimed their perks would otherwise be asked
// for money they already give. That button silences the card for good and sends
// them to the place where they can finally claim what they paid for.
(function () {
  const BMC = 'https://www.buymeacoffee.com/marcimastro98';
  // Buy Me a Coffee's own membership tab. The monthly option is the ask; the
  // one-off is offered underneath it, not instead of it.
  const BMC_MONTHLY = BMC + '/membership';

  const DAYS_SINCE_FIRST_RUN = 30;
  const DISTINCT_DAYS_USED = 10;
  // Long enough that the dashboard has finished painting and the person has
  // looked at it. The Discord card uses 1400ms; this one is deliberately later,
  // so the two can never arrive together on the one boot where both are due.
  const SHOW_AFTER_MS = 4200;

  const CARDS = () => (window.XenonStartupCards || null);
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  const HEART = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9A5.3 5.3 0 0 1 12 6.2 5.3 5.3 0 0 1 21.6 12c-2.1 4.4-9.6 9-9.6 9z"/></svg>';
  // One glyph per perk. Drawn rather than written because three small objects
  // read as things you get; the same three facts in a grey sentence read as
  // small print, and this card has one job.
  const PERK_ICONS = {
    themes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="9.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="9.5" cy="15" r="1.2" fill="currentColor" stroke="none"/><path d="M14.5 14.5h2a2 2 0 0 1 0 4h-2z"/></svg>',
    discord: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.3 4.4A19.8 19.8 0 0 0 16.9 3.1l-.2.4c1.2.4 2.3.9 3.3 1.5a13 13 0 0 0-10.4 0c1-.6 2.1-1.1 3.3-1.5l-.2-.4A19.7 19.7 0 0 0 3.7 4.4C.5 9 .1 13.6.1 18a19.9 19.9 0 0 0 6 3l1.2-1.7c-.7-.2-1.3-.5-1.9-.9l.4-.3a13 13 0 0 0 12.4 0l.4.3c-.6.4-1.2.7-1.9.9l1.2 1.7a19.8 19.8 0 0 0 6-3c.1-4.4-.4-9-3.6-13.6zM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4S9.2 15.3 8 15.3zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"/></svg>',
    name: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>',
  };
  const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function open(url) { try { window.open(url, '_blank', 'noopener'); } catch { /* ignore */ } }

  // Days between two YYYY-MM-DD days, counted on the dates themselves so a clock
  // change or a daylight-saving hour cannot move the answer.
  function daysSince(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return -1;
    const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor((today - then) / 86400000);
  }

  // The moments Xenon is being used for something. Same body-class convention
  // the toast system's do-not-disturb already reads, plus the two states where a
  // card would be actively wrong.
  function busyRightNow() {
    try {
      const c = document.body.classList;
      return c.contains('lock-screen-active')
        || c.contains('ai-voice-mode') || c.contains('ai-listening')
        || c.contains('game-mode') || c.contains('ambient-scene-open')
        || c.contains('ambient-canvas-open');
    } catch { return true; }   // cannot tell → do not interrupt
  }

  // Does this machine already hold a supporter pass? A boolean, never the code.
  // Any failure answers "yes": not asking someone who might already give is the
  // recoverable error, asking someone who does is not.
  async function alreadySupporter() {
    try {
      const r = await fetch('/api/community/supporter', { cache: 'no-store' });
      const d = await r.json();
      return !(d && d.ok && d.saved === false);
    } catch { return true; }
  }

  function showCard() {
    if (document.getElementById('support-ask')) return;
    const card = document.createElement('div');
    card.className = 'discord-invite support-ask';   // same shell, same corner, same motion
    card.id = 'support-ask';
    card.setAttribute('role', 'complementary');
    card.setAttribute('aria-label', t('support_ask_title', 'Xenon is free, and stays free'));

    const head = document.createElement('div');
    head.className = 'discord-invite-head';
    const logo = document.createElement('div');
    logo.className = 'discord-invite-logo support-ask-logo';
    logo.innerHTML = HEART;                // static, trusted markup
    const title = document.createElement('div');
    title.className = 'discord-invite-title';
    title.textContent = t('support_ask_title', 'Xenon is free, and stays free');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'discord-invite-close';
    close.setAttribute('aria-label', t('close', 'Close'));
    close.innerHTML = CLOSE;               // static, trusted markup
    // Even the × is final here. This card is a once-per-install event, so a
    // "maybe next launch" would turn one ask into an indefinite series.
    close.addEventListener('click', () => { remember(); hide(); });
    head.append(logo, title, close);

    const text = document.createElement('p');
    text.className = 'discord-invite-text';
    text.textContent = t('support_ask_text',
      'One person writes Xenon, in their spare time. There are no ads, no investors and no paid version — and that is not changing. If it has earned a place on your screen, a few euros a month is what keeps it going.');

    const perks = document.createElement('ul');
    perks.className = 'support-ask-perks';
    [
      ['themes', 'support_perk_themes', 'Exclusive themes and widgets'],
      ['discord', 'support_perk_discord', 'A supporter role on Discord'],
      ['name', 'support_perk_name', 'Your name on the site'],
    ].forEach(([icon, key, fb]) => {
      const li = document.createElement('li');
      const ic = document.createElement('span');
      ic.className = 'support-perk-icon';
      ic.innerHTML = PERK_ICONS[icon];     // static, trusted markup
      const tx = document.createElement('span');
      tx.textContent = t(key, fb);
      li.append(ic, tx);
      perks.appendChild(li);
    });

    const actions = document.createElement('div');
    actions.className = 'discord-invite-actions support-ask-actions';

    const monthly = document.createElement('button');
    monthly.type = 'button';
    monthly.className = 'discord-invite-join support-ask-monthly';
    monthly.innerHTML = HEART;             // static, trusted markup
    const monthlyLabel = document.createElement('span');
    monthlyLabel.textContent = t('support_ask_monthly', 'Support monthly');
    monthly.appendChild(monthlyLabel);
    monthly.addEventListener('click', () => { open(BMC_MONTHLY); remember(); hide(); });

    const once = document.createElement('button');
    once.type = 'button';
    once.className = 'discord-invite-dismiss support-ask-once';
    once.textContent = t('support_ask_once', 'Or give once');
    once.addEventListener('click', () => { open(BMC); remember(); hide(); });

    // Third row, quieter: for the supporter this card should never have reached.
    const already = document.createElement('button');
    already.type = 'button';
    already.className = 'support-ask-already';
    already.textContent = t('support_ask_already', 'I already support Xenon');
    already.addEventListener('click', () => {
      remember();
      hide();
      // Straight to where a pass is entered: they are entitled to the perks and
      // evidently have not claimed them, which is the actual thing to fix here.
      //
      // And SAY so. Pressing this used to close the card and silently open a
      // settings page, which from the outside looks like nothing happened at
      // all — the first question asked about it was "what does that button
      // even do?". The thank-you is the answer, and it carries the one
      // instruction that turns a supporter into a supporter with their perks.
      try {
        if (typeof openSettings === 'function') openSettings();
        if (typeof settingsSetCategory === 'function') settingsSetCategory('support');
      } catch { /* the card is gone either way, which is what they asked for */ }
      try {
        if (window.XenonToast) {
          window.XenonToast.show({
            type: 'success',
            duration: 9000,
            important: true,          // the reply to a press is never "quiet hours"
            title: t('support_thanks_title', 'Thank you, genuinely'),
            message: t('support_thanks_msg', 'If you have a supporter code, enter it here to unlock the exclusive themes and widgets. You will not be asked again either way.'),
          });
        }
      } catch { /* a missing toast never breaks the button */ }
    });

    actions.append(monthly, once);
    card.append(head, text, perks, actions, already);
    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add('is-in'));
  }

  function hide() {
    const card = document.getElementById('support-ask');
    if (!card) return;
    card.classList.remove('is-in');
    setTimeout(() => { card.remove(); }, 320);
  }

  function remember() {
    const c = CARDS();
    if (c && typeof c.rememberSupportAsk === 'function') c.rememberSupportAsk();
  }

  async function maybeShow() {
    const c = CARDS();
    // Nothing can be remembered without that module, so nothing may be shown:
    // an ask that cannot be silenced for good is the complaint this is designed
    // to avoid, not the feature.
    if (!c || typeof c.supportAskDismissed !== 'function') return;
    if (c.supportAskDismissed()) return;

    const use = typeof c.usageHistory === 'function' ? c.usageHistory() : null;
    if (!use) return;                                   // server copy not in yet
    if (daysSince(use.firstRunDay) < DAYS_SINCE_FIRST_RUN) return;
    if (use.usageDays < DISTINCT_DAYS_USED) return;
    if (await alreadySupporter()) return;

    setTimeout(() => {
      // Re-checked at the last moment: the wait is long enough for a voice
      // session or the lock screen to have started since. Not shown today is not
      // "shown tomorrow with a grudge" — the gate simply passes again next time.
      if (busyRightNow()) return;
      if (c.supportAskDismissed()) return;
      showCard();
    }, SHOW_AFTER_MS);
  }

  function init() {
    const c = CARDS();
    // Same rule as the Discord card: ask only once the stored answer is really
    // known, or a blind local mirror could put this up over a dismissal that is
    // sitting safely on disk.
    if (c && typeof c.whenReady === 'function') c.whenReady(() => { maybeShow(); });
    else maybeShow();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
