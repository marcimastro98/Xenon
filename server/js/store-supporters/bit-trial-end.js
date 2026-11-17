// The end of the welcome Sparks, in Bit's chat.
//
// The trial lasts a few days (the hub decides how many). In its last two days
// one reminder a day says when it ends and what keeps Bit on. When it is over
// the server says so (`trialEnded` on /api/ai/xenon/balance, kept by
// welcome-trial/trial-end.js), and the card shown while Bit cannot answer turns
// from "buy Sparks" into the supporter offer: what a month costs and buys, the
// way to join, and the other ways for whoever wants none of it.
//
// The offer's numbers come from js/store-supporters/sparks-store.js, so they never drift from the
// Store. Both links go through the hub's counted redirect, under their own
// labels, so the hub can tell whether this ask works.
(function () {
  const DAY = 24 * 3600 * 1000;
  const REMIND_WITHIN_MS = 2 * DAY;
  const REMIND_KEY = 'xenon.bitTrialRemindDay';
  const CARD = '[data-chatf="nokey"]';
  const END = '[data-bit-trial-end]';

  const credits = () => window.XenonCredits;
  const state = () => (credits() && credits().state) || {};

  // Pure: is a reminder due? `untilSec` is the hub's end, in seconds; `lastDay`
  // the day a reminder was last shown here.
  function remindDue(untilSec, now, lastDay) {
    const left = untilSec * 1000 - now;
    return Number.isInteger(untilSec) && left > 0 && left <= REMIND_WITHIN_MS && lastDay !== new Date(now).toDateString();
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function dateText(ms) {
    // `lang` is settings.js's shared-scope UI language.
    try { return new Date(ms).toLocaleDateString(typeof lang === 'string' ? lang : undefined, { day: 'numeric', month: 'long' }); }
    catch { return new Date(ms).toLocaleDateString(); }
  }

  function openSupport(source) {
    const c = window.Xenon && window.Xenon.constants;
    if (!c || typeof c.supportUrl !== 'function') return;
    try { window.open(c.supportUrl(source), '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ }
  }

  // "5 USD a month, 300 Sparks..." from the Store's own numbers; '' without the Store.
  function offerLine() {
    const plan = window.SparksStore;
    if (!plan || !plan.MEMBER_USD || !plan.MONTHLY) return '';
    return t('bit_trial_end_line').replace('{usd}', String(plan.MEMBER_USD)).replace('{n}', String(plan.MONTHLY));
  }

  // The words and buttons of the ended trial, built once per chat copy beside
  // the usual ones, which stay in the page for whoever gets Sparks some other way.
  function endBlock() {
    const words = el('div', 'bit-nokey-words');
    words.dataset.bitTrialEnd = '';
    const p = el('p');
    p.append(el('strong', '', t('bit_trial_end_title')), el('span', '', offerLine()));
    const actions = el('div', 'bit-nokey-actions');
    const join = el('button', 'bit-main-btn', t('trial_support'));
    join.type = 'button';
    join.addEventListener('click', () => openSupport('welcome-end'));
    const other = el('button', 'bit-quiet-btn', t('bit_trial_end_other'));
    other.type = 'button';
    other.addEventListener('click', () => { if (credits()) credits().openCredits(); });
    actions.append(join, other);
    words.append(p, actions);
    return words;
  }

  function paintCard(card, ended) {
    let block = card.querySelector(END);
    if (ended && !block) { block = endBlock(); card.appendChild(block); }
    if (block) block.hidden = !ended;
    card.querySelectorAll('.bit-nokey-words').forEach((w) => { if (w !== block) w.hidden = ended; });
  }

  // Cheap and idempotent, called with the credits chips (renderChips), which a
  // language change repaints too: words built in another language are rebuilt.
  let builtLang = '';
  function paint() {
    const now = typeof lang === 'string' ? lang : '';
    if (now !== builtLang) {
      document.querySelectorAll(END).forEach((b) => b.remove());
      builtLang = now;
    }
    const ended = state().status === 'no_code' && state().trialEnded === true;
    document.querySelectorAll(CARD).forEach((card) => paintCard(card, ended));
  }

  function readDay() { try { return localStorage.getItem(REMIND_KEY) || ''; } catch { return ''; } }
  function writeDay(day) { try { localStorage.setItem(REMIND_KEY, day); } catch { /* private window: may show again */ } }

  function remindIfClose() {
    const s = state();
    const now = Date.now();
    if (s.status !== 'ok' || !remindDue(s.welcomeUntil, now, readDay()) || !window.XenonToast) return;
    writeDay(new Date(now).toDateString());
    const plan = window.SparksStore;
    window.XenonToast.show({
      type: 'info',
      title: t('bit_trial_remind_title').replace('{date}', dateText(s.welcomeUntil * 1000)),
      message: t('bit_trial_remind_body').replace('{n}', String((plan && plan.MONTHLY) || '')),
      duration: 10000,
      actions: [{ label: t('trial_support'), primary: true, onClick: () => openSupport('welcome-remind') }],
    });
  }

  if (credits() && typeof credits().onChange === 'function') credits().onChange(remindIfClose);

  window.BitTrialEnd = { paint, remindDue };
})();
