'use strict';

// ── A word from Bit when the Scintille run low or out ───────────────────────
//
// The chat already offers the packs under the reply that spends the last of
// them (ai-bit-chat.js buyRow). Sparks also go where the chat is not open: a
// creation from the Maker, a voice turn, a reply read on another screen. This
// files one of Bit's messages for that (js/bit-messages.js).
//
//   * Only on the Scintille provider, with a balance read from the hub.
//   * One message per level per month (ids carry the month): the included ones
//     come back on the first, so a new month is a new state worth a word.
//   * It names what Scintille are (Xenon's credits, bought ones never expire)
//     and leads to the Store's Sparks tab, the one place they are sold.
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

  // The message for this balance, or null when there is nothing to say.
  function messageFor(level, at) {
    if (!LEVELS.includes(level)) return null;
    return {
      id: 'sparks:' + level + ':' + month(at),
      kind: 'sparks',
      title: t(TITLE[level]),
      line: t(LINE[level]),
      body: t(LINE[level]) + ' ' + t('sparks_mail_what'),
      action: { type: 'sparks', label: t('sparks_buy_more') },
    };
  }

  function check() {
    const C = window.XenonCredits;
    if (!C || !window.BitMessages || !C.active() || C.state.status !== 'ok') return;
    const m = messageFor(C.level(), Date.now());
    if (m) window.BitMessages.file([m]);
  }

  if (window.XenonCredits) window.XenonCredits.onChange(check);

  window.SparksMail = { messageFor, check };
})();
