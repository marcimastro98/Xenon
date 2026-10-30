'use strict';

// ── The December appeal ────────────────────────────────────────────────────
//
// Once a year, in December, a short note from the person who makes Xenon, with
// the one number that says where the project stands: how many people pay for
// it against how many it takes to cover its costs (js/support-goal.js).
//
// Why December, and why this shape. The end of the year is when people give,
// and the appeals that work are personal and concrete: a named person, a real
// goal and the count so far, instead of a generic donate button. Thunderbird's
// in-app appeal and Wikipedia's letter from its founder are the models.
//
// It is the one-time ask's (js/support-card.js) yearly sibling, keeps all of its
// rules, and adds three of its own:
//   * December only, and at most once per calendar year. The year is stored in
//     hub settings, on disk, for the same reason the ask's flag is.
//   * Only after the one-time ask, and at least 30 days after it: two requests
//     for money a few days apart is the nag both cards exist to avoid.
//   * "I already support Xenon", on either card, ends it for good.
// A boot where the moment is wrong (a game, a scene, another card, anything the
// interrupt arbiter calls busy) does not use up the year: it tries again on the
// next boot, any day until December 31.
(function () {
  const BMC = 'https://www.buymeacoffee.com/marcimastro98';
  // Counted through the hub under its own label, so the admin panel can tell
  // this card's presses from the one-time ask's.
  function supportLink(plan) {
    const c = window.Xenon && window.Xenon.constants;
    if (c && typeof c.supportUrl === 'function') return c.supportUrl('app-appeal', plan);
    return plan === 'once' ? BMC : BMC + '/membership';
  }

  const DECEMBER = 11;                  // Date#getMonth()
  const DAYS_SINCE_FIRST_RUN = 30;
  const DISTINCT_DAYS_USED = 10;
  const DAYS_AFTER_ASK = 30;
  // The ask's slot. The two are never due on the same boot (this one needs the
  // ask already answered), and both arrive before the share invitation.
  const SHOW_AFTER_MS = 4200;

  const CARDS = () => (window.XenonStartupCards || null);
  const ASK = () => (window.XenonSupportAsk || null);
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function open(url) { try { window.open(url, '_blank', 'noopener'); } catch { /* ignore */ } }

  // Never two cards in the corner, and never over a dialog, the Store, What's
  // New or a Claude Code approval: the arbiter's list of "something is up".
  function screenTaken() {
    if (document.getElementById('discord-invite')) return true;
    const I = window.XenonInterrupts;
    return !!(I && typeof I.busy === 'function' && I.busy());
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildHead(a) {
    const head = el('div', 'discord-invite-head');
    const logo = el('div', 'discord-invite-logo support-ask-logo');
    logo.innerHTML = a.HEART;            // static, trusted markup
    const title = el('div', 'discord-invite-title', t('support_appeal_title', 'A note from Marcello, who makes Xenon'));
    const close = el('button', 'discord-invite-close');
    close.type = 'button';
    close.setAttribute('aria-label', t('close', 'Close'));
    close.innerHTML = a.CLOSE;           // static, trusted markup
    close.addEventListener('click', () => { remember(); hide(); });
    head.append(logo, title, close);
    return head;
  }

  // The count and the bar. Built hidden: render() shows it only with a number
  // the hub actually answered.
  function buildGoal(goal) {
    const box = el('div', 'support-goal');
    box.hidden = true;
    const bar = el('progress', 'support-goal-bar');
    box.append(el('p', 'support-goal-line'), bar);
    if (window.XenonSupportGoal) window.XenonSupportGoal.render(box, goal);
    return box;
  }

  function buildActions(a) {
    const actions = el('div', 'discord-invite-actions support-ask-actions');
    const monthly = el('button', 'discord-invite-join support-ask-monthly');
    monthly.type = 'button';
    const heart = el('span', 'support-ask-heart');
    heart.innerHTML = a.HEART;           // static, trusted markup
    monthly.append(heart, el('span', null, t('support_ask_monthly', 'Support monthly')));
    monthly.addEventListener('click', () => { open(supportLink('monthly')); remember(); hide(); });

    const once = el('button', 'discord-invite-dismiss support-ask-once', t('support_ask_once', 'Just once: $5 or $25'));
    once.type = 'button';
    once.addEventListener('click', () => { open(supportLink('once')); remember(); hide(); });
    actions.append(monthly, once);
    return actions;
  }

  // "It does not pay for itself yet" only while the count says so. Past the
  // goal, or with no count to check it against, the note leaves the costs out.
  function noteText(goal) {
    const G = window.XenonSupportGoal;
    if (G && G.shortOfGoal(goal)) {
      return t('support_appeal_text',
        "I make Xenon on my own, in my spare time. It's free and it will stay free, but for now it doesn't pay for itself, so I cover the costs. If it's been useful to you this year, $5 a month helps me keep it going, and you also unlock the supporter themes and widgets.");
    }
    return t('support_appeal_text_plain',
      "I make Xenon on my own, in my spare time. It's free and it will stay free. If it's been useful to you this year, $5 a month helps me keep it going, and you also unlock the supporter themes and widgets.");
  }

  function showCard(goal) {
    const a = ASK();
    if (!a || document.getElementById('support-appeal')) return;
    const card = el('div', 'discord-invite support-ask support-appeal');   // the ask's shell and palette
    card.id = 'support-appeal';
    card.setAttribute('role', 'complementary');
    card.setAttribute('aria-label', t('support_appeal_title', 'A note from Marcello, who makes Xenon'));

    const text = el('p', 'discord-invite-text', noteText(goal));
    const C = window.XenonCredits;
    const sparks = C ? C.offerLine(t('support_sparks_also', "Every month you also get 300 Sparks, Xenon's credits."), 'support-appeal-sparks') : null;

    const already = el('button', 'support-ask-already', t('support_ask_already', 'I already support Xenon'));
    already.type = 'button';
    already.addEventListener('click', () => { silence(); hide(); a.thankSupporter(); });

    card.append(buildHead(a), text, ...(sparks ? [sparks] : []), buildGoal(goal), buildActions(a), already);
    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add('is-in'));
  }

  function hide() {
    const card = document.getElementById('support-appeal');
    if (!card) return;
    card.classList.remove('is-in');
    setTimeout(() => { card.remove(); }, 320);
  }

  // Every exit is final for this year.
  function remember() {
    const c = CARDS();
    if (c && typeof c.rememberSupportAppeal === 'function') c.rememberSupportAppeal(new Date().getFullYear());
  }

  function silence() {
    const c = CARDS();
    if (c && typeof c.silenceSupportAppeal === 'function') c.silenceSupportAppeal();
  }

  function dueThisYear(c) {
    const now = new Date();
    return now.getMonth() === DECEMBER && c.supportAppealYear() < now.getFullYear();
  }

  async function maybeShow() {
    const c = CARDS();
    const a = ASK();
    // Without these two nothing can be remembered or checked, so nothing shows.
    if (!c || typeof c.rememberSupportAppeal !== 'function' || !a) return;
    if (!dueThisYear(c)) return;
    // After the one-time ask, and a month after it. A day stamp missing means
    // the ask predates the field, which is longer ago than that.
    if (!c.supportAskDismissed()) return;
    const askDay = c.supportAskSeenDay();
    if (askDay && a.daysSince(askDay) < DAYS_AFTER_ASK) return;
    const use = typeof c.usageHistory === 'function' ? c.usageHistory() : null;
    if (!use) return;                                   // server copy not in yet
    if (a.daysSince(use.firstRunDay) < DAYS_SINCE_FIRST_RUN) return;
    if (use.usageDays < DISTINCT_DAYS_USED) return;
    if (await a.alreadySupporter()) return;
    // Read before the card goes up, so it arrives whole instead of growing a bar.
    const goal = window.XenonSupportGoal ? await window.XenonSupportGoal.load() : null;

    setTimeout(() => {
      // Re-checked at the last moment, like the ask: not shown today is not
      // shown tomorrow with a grudge, the gate simply passes again next boot.
      if (a.busyRightNow()) return;
      if (screenTaken()) return;
      if (!dueThisYear(c)) return;
      showCard(goal);
    }, SHOW_AFTER_MS);
  }

  function init() {
    if (typeof isLayerPage === 'function' && isLayerPage()) return;   // shown by the main dashboard, never by a layer window
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
