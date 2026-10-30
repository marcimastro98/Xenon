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
//     It is a letter in Bit's mail (js/bit-mail.js), filed without a sound or a
//     window; Bit's one note a day says it arrived, and that note waits while
//     Xenon is being USED for something (bit-mail-core.js quiet()).
//   * No modal, no corner card, nothing blocked. busyRightNow() stays exported
//     for the December appeal, which is still a corner card.
//
// The wording leads with the monthly option on purpose. The existing framing is
// "buy me a coffee", which is a one-off by its nature; recurring support is what
// makes a project sustainable, and nobody was being offered it.
//
// It also carries a third button, "I already support Xenon", which is not
// politeness: the supporter check below can only see a pass that was REDEEMED in
// the app, so a supporter who never claimed their perks would otherwise be asked
// for money they already give. That button silences the ask for good and sends
// them to the place where they can finally claim what they paid for.
(function () {
  const BMC = 'https://www.buymeacoffee.com/marcimastro98';
  // Buy Me a Coffee's own membership tab. The monthly option is the ask; the
  // one-off is offered underneath it, not instead of it. Counted through the hub
  // when the shared constants loaded, straight to the page otherwise, so the
  // button never goes dead.
  function supportLink(plan) {
    const c = window.Xenon && window.Xenon.constants;
    if (c && typeof c.supportUrl === 'function') return c.supportUrl('app-ask', plan);
    return plan === 'once' ? BMC : BMC + '/membership';
  }

  const DAYS_SINCE_FIRST_RUN = 30;
  const DISTINCT_DAYS_USED = 10;

  const CARDS = () => (window.XenonStartupCards || null);
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  // The viewBox starts at y = 0.25 and not at 0, which is the whole reason this
  // heart looks centred. The path is symmetric left to right, but its ink runs
  // from y 3.49 to y 21.0 — its middle is 12.246, not 12 — so a plain
  // "0 0 24 24" box hangs the heart a quarter of a unit high in whatever holds
  // it. Shifting the window down by that quarter unit puts the shape's own
  // middle on the box's middle. If the path is ever redrawn, re-measure with
  // getBBox() and move this number with it.
  const HEART = '<svg viewBox="0 0.25 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9A5.3 5.3 0 0 1 12 6.2 5.3 5.3 0 0 1 21.6 12c-2.1 4.4-9.6 9-9.6 9z"/></svg>';
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

  // The ask is a letter in Bit's mail (js/bit-mail.js), filed once. Opening it
  // draws the card's contents here; `ctx` is the mail's { close, remove }.
  function drawLetter(_letter, node, ctx) {
    node.appendChild(el('p', 'bitmail-letter-line', t('support_letter_text', 'One person writes it, in their spare time. If it is useful to you, you can support it and get:')));

    const perks = document.createElement('ul');
    perks.className = 'bitmail-perks';
    [
      ['themes', 'support_perk_themes', 'Exclusive themes and widgets'],
      ['sparks', 'support_perk_sparks', '300 Sparks a month, Xenon\'s credits'],
      ['discord', 'support_perk_discord', 'A supporter role on Discord'],
      ['name', 'support_perk_name', 'Your name on the site'],
    ].forEach(([icon, key, fb]) => {
      const li = document.createElement('li');
      const ic = el('span', 'bitmail-perk-icon');
      // The Scintilla is Bit's own sprite (js/xenon-credits.js), never a stand-in glyph.
      if (icon === 'sparks' && window.XenonCredits) ic.appendChild(window.XenonCredits.offerMark());
      else ic.innerHTML = PERK_ICONS[icon] || '';   // static, trusted markup
      li.append(ic, el('span', '', t(key, fb)));
      perks.appendChild(li);
    });

    const actions = el('div', 'bitmail-actions');
    const monthly = el('button', 'bitmail-btn is-main', t('support_letter_monthly', 'Support with 5 USD a month'));
    monthly.type = 'button';
    monthly.addEventListener('click', () => { open(supportLink('monthly')); ctx.close(); });
    const once = el('button', 'bitmail-btn', t('support_letter_once', 'Just once: 5 or 25 USD'));
    once.type = 'button';
    once.addEventListener('click', () => { open(supportLink('once')); ctx.close(); });
    actions.append(monthly, once);

    // Quieter: for the supporter this letter should never have reached.
    const already = el('button', 'bitmail-link', t('support_ask_already', 'I already support Xenon'));
    already.type = 'button';
    already.addEventListener('click', () => {
      remember();
      // The thank-you promises they will not be asked again, so the December
      // appeal (js/support-appeal.js) is silenced for good as well.
      silenceAppeal();
      ctx.remove();
      thankSupporter();
    });

    node.append(perks, actions, already);
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function remember() {
    const c = CARDS();
    if (c && typeof c.rememberSupportAsk === 'function') c.rememberSupportAsk();
  }

  function silenceAppeal() {
    const c = CARDS();
    if (c && typeof c.silenceSupportAppeal === 'function') c.silenceSupportAppeal();
  }

  // The answer to "I already support Xenon", on this card and on the December
  // appeal. Straight to where a pass is entered: they are entitled to the perks
  // and evidently have not claimed them, which is the actual thing to fix here.
  //
  // And SAY so. Pressing this used to close the card and silently open a
  // settings page, which from the outside looks like nothing happened at all —
  // the first question asked about it was "what does that button even do?". The
  // thank-you is the answer, and it carries the one instruction that turns a
  // supporter into a supporter with their perks.
  function thankSupporter() {
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
  }

  // The December appeal is this card's yearly sibling and borrows its parts
  // rather than keeping a second copy of each.
  window.XenonSupportAsk = { HEART, CLOSE, daysSince, busyRightNow, alreadySupporter, thankSupporter };
  if (window.BitMail) window.BitMail.register('support', drawLetter);

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
    if (!window.BitMail) return;

    // Filed once, and remembered the moment it is filed: the letter waits in the
    // box until it is read, so "once" no longer depends on catching a good
    // moment. Bit's one note a day says it arrived, and only when nothing is
    // going on (bit-mail-core.js quiet()).
    window.BitMail.post({
      id: 'support:ask',
      kind: 'support',
      title: t('support_ask_title', 'Xenon is free, and stays free'),
      note: t('support_ask_title', 'Xenon is free, and stays free'),
    });
    remember();
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
