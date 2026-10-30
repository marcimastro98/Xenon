'use strict';

// ── Bit's mail: a letter when the Scintille run low or out ──────────────────
//
// The chat already offers the packs under the reply that spends the last of
// them (ai-bit-chat.js buyRow). Sparks also go where the chat is not open: a
// creation from the Maker, a voice turn, a reply read on another screen. This
// files one letter in Bit's mail for that, the passive place where news that is
// not urgent waits to be opened (see bit-mail-core.js for the research). It
// never opens a window; Bit's one note a day says it arrived.
//
//   * Only on the Scintille provider, with a balance read from the hub.
//   * One letter per level per month (ids carry the month): the included ones
//     come back on the first, so a new month is a new state worth a word.
//   * The letter names what Scintille are (Xenon's credits, bought ones never
//     expire) and carries the same three packs as Settings → Bit.
(function () {
  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };
  const LEVELS = ['low', 'empty'];
  const TITLE = { low: 'sparks_mail_low_title', empty: 'sparks_mail_empty_title' };
  // Not the chat's xai_low / xai_empty: those open with what the title already says.
  const LINE = { low: 'sparks_mail_low_line', empty: 'sparks_mail_empty_line' };

  function month(at) {
    const d = new Date(at);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // The letter for this balance, or null when there is nothing to say.
  function letterFor(level, at) {
    if (!LEVELS.includes(level)) return null;
    const title = t(TITLE[level]);
    return { id: 'sparks:' + level + ':' + month(at), kind: 'sparks', title, note: title, line: t(LINE[level]), data: { level } };
  }

  // Opening the letter draws this.
  function drawLetter(letter, node) {
    const C = window.XenonCredits;
    const level = letter.data && LEVELS.includes(letter.data.level) ? letter.data.level : 'low';
    const line = document.createElement('p');
    line.className = 'bitmail-letter-line';
    line.textContent = t(LINE[level]);
    const what = document.createElement('p');
    what.className = 'bitmail-letter-line';
    what.textContent = t('sparks_mail_what');
    node.append(line, what);
    // The packs are sold in the Store's Sparks tab: the letter leads there.
    if (!C || typeof C.openShop !== 'function') return;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'bitmail-btn bitmail-packs';
    if (typeof C.offerMark === 'function') go.append(C.offerMark());
    const label = document.createElement('span');
    label.textContent = t('sparks_buy_more');
    go.append(label);
    go.addEventListener('click', () => C.openShop());
    node.append(go);
  }

  function check() {
    const C = window.XenonCredits;
    if (!C || !window.BitMail || !C.active() || C.state.status !== 'ok') return;
    const l = letterFor(C.level(), Date.now());
    if (l) window.BitMail.post(l);
  }

  if (window.BitMail) window.BitMail.register('sparks', drawLetter);
  if (window.XenonCredits) window.XenonCredits.onChange(check);

  window.SparksMail = { letterFor, check };
})();
