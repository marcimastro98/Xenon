'use strict';
// The window that sells a Store entry for Sparks. It only draws: the buying rules
// stay in the import dialog (js/preset-share.js), which hands over its own controls
// (the box, the buttons, the code field) and calls sync() when they change. What a
// moment shows comes from js/buy-sheet-model.js, the pieces from js/buy-sheet-parts.js,
// the purchase's animation from js/buy-sheet-motion.js.
(function () {
  const M = window.BuySheetModel;
  const P = window.BuySheetParts;
  const { t, fill } = P;
  const el = makeEl; // shared DOM factory from utils.js

  const credits = () => window.XenonCredits;

  // Turns the dialog's own box into the sheet, in the entry's paper and ink.
  function dress(o, colors, nameId, children) {
    const sheet = o.modal;
    sheet.className = 'buy-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', nameId);
    sheet.tabIndex = -1;
    sheet.style.setProperty('--buy-paper', colors.paper);
    sheet.style.setProperty('--buy-ink', colors.ink);
    sheet.style.setProperty('--buy-mark', colors.mark);
    sheet.style.setProperty('--buy-mark-ink', colors.markInk);
    sheet.replaceChildren(...children);
    o.overlay.classList.add('buy-overlay');
    sheet.focus({ preventScroll: true });
    return sheet;
  }

  // Bit lives on this overlay, so the freeze the overlay itself asks for does not hold it.
  function mountBit(host) {
    if (!window.BitApp) return null;
    const hold = window.BitApp.TILE_HOLD.filter((name) => name !== 'overlay-frozen');
    return window.BitApp.mount(host, { mood: 'idle', fidgets: true, calm: true, label: 'Bit', hold });
  }

  function walletHeld() {
    const s = credits() && credits().state;
    return s && s.status === 'ok' && Number.isFinite(s.balance) ? Math.floor(s.balance) : null;
  }

  function mount(o) {
    const card = M.card(o.item);
    const nameId = 'buy-name-' + Math.random().toString(36).slice(2, 9);
    const store = window.SparksStore;
    const plan = { n: store ? store.MONTHLY : 300, usd: store ? store.MEMBER_USD : 5 };
    const stop = new AbortController();
    const on = (node, type, fn) => node.addEventListener(type, fn, { signal: stop.signal });

    const { frame, bit } = P.picture(card);
    const offer = P.offer(o, plan);
    const pass = P.pass(o, plan, offer.price, on);
    const opens = P.opens();
    const receipt = P.receipt(card.name);
    const foot = P.foot(o);

    // The code field, for whoever has one, and the small print.
    o.code.className = 'buy-code-field';
    o.codeNote.className = 'buy-note';
    const codeRow = el('div', 'buy-code');
    codeRow.appendChild(o.code);
    const stub = el('div', 'buy-stub');
    stub.append(offer.block, pass.block, opens.block, receipt.block, codeRow, o.codeNote);
    if (o.note) { o.note.className = 'buy-note'; stub.appendChild(o.note); }
    stub.appendChild(foot.block);

    const sheet = dress(o, card.colors, nameId, [P.closeButton(o.close, on), frame, P.pitch(card, nameId), stub]);
    const player = mountBit(bit);
    const motion = window.BuySheetMotion.create(o.overlay);

    let last = { known: false, typed: '' };
    let chosen = false;   // "Buy just this one": the offer stays until Back.
    let asking = false;   // Buy was pressed without the box.
    let reported = null;  // What the hub said this code holds.
    let result = null;    // How the purchase ended.
    let flying = false;
    let gone = false;

    // A typed code pays with its own balance, which only the hub knows.
    const held = () => {
      if (reported !== null) return reported;
      return /^X[CS]/.test(last.typed) ? null : walletHeld();
    };

    function placeOpen(d) {
      const open = o.open;
      open.hidden = !d.slot;
      if (!d.slot) return;
      const host = d.slot === 'code' ? codeRow : d.view === 'done' ? receipt.act : opens.block;
      if (open.parentNode !== host) host.appendChild(open);
      open.className = d.slot === 'code' ? 'buy-code-go' : 'buy-main';
      open.textContent = d.slot === 'code' ? t('sparks_sheet_unlock', 'Unlock') : t('sparks_sheet_install', 'Install now');
    }

    function leftText(d, n) {
      if (d.line === 'short') return fill(t('sparks_sheet_short', 'You have {b}: you need {m} more.'), { b: n, m: o.price - n });
      if (d.line === 'left') return fill(t('sparks_sheet_left', 'You have {b}: {r} left after this.'), { b: n, r: n - o.price });
      return '';
    }

    function paintOffer(d, n) {
      offer.left.textContent = leftText(d, n);
      offer.left.hidden = !d.line;
      offer.gets.hidden = !d.gets;
      offer.tick.hidden = !d.tick;
      offer.tick.classList.toggle('want', asking && d.tick);
      offer.need.hidden = !(asking && d.tick);
      o.buy.hidden = !d.buy;
      o.more.hidden = !d.more;
      offer.joinAlt.hidden = !d.joinAlt;
    }

    function paintFoot(d) {
      foot.seller.hidden = !d.seller;
      o.other.hidden = !d.other;
      foot.have.hidden = !d.have;
      foot.back.hidden = !d.back;
      foot.block.hidden = d.view === 'done';
      codeRow.hidden = !d.code;
      o.code.hidden = !d.code;
      o.codeNote.hidden = !d.code;
    }

    function paint() {
      if (gone || flying) return;
      const n = held();
      const d = M.decide({ ...last, price: o.price, sparksOnly: o.sparksOnly || last.sparksOnly === true, chosen, held: n, bought: !!result });
      stub.classList.toggle('is-waiting', !last.known && !result);
      sheet.classList.toggle('is-done', d.view === 'done');
      offer.block.hidden = d.view !== 'offer';
      pass.block.hidden = d.view !== 'pass';
      opens.block.hidden = d.view !== 'opens';
      receipt.block.hidden = d.view !== 'done';
      opens.line.textContent = last.opensText || '';
      pass.trial.hidden = !last.trial;
      pass.join.hidden = !!last.trial;
      paintOffer(d, n);
      paintFoot(d);
      placeOpen(d);
      const mood = o.box.checked ? 'happy' : 'idle';
      if (player && !result && player.mood !== mood) player.setMood(mood);
    }

    function sync(state) {
      if (state.typed !== last.typed) reported = null;
      last = state;
      paint();
    }

    function askTick() {
      if (offer.tick.hidden) {
        const field = o.code.querySelector('input');
        if (field && !o.code.hidden) field.focus();
        return;
      }
      asking = true;
      paint();
      o.box.focus();
      if (player) player.play('wave');
    }

    // The sheet holds its height through the wait, so the button does not move.
    function busy(waiting) {
      if (gone) return;
      o.buy.textContent = waiting ? t('sparks_sheet_wait', 'One moment') : t('sparks_buy_now', 'Buy now');
      sheet.style.minHeight = waiting ? sheet.offsetHeight + 'px' : '';
    }

    function setHeld(n) {
      reported = Number.isInteger(n) ? n : null;
      paint();
    }

    function showHeld(n) {
      offer.left.hidden = false;
      offer.left.textContent = fill(t('sparks_sheet_have', 'You have {b}.'), { b: n });
    }

    function doneWords(r) {
      if (!r.bought) return t('sparks_owned', 'You already own it: installing it again, no Sparks spent.');
      const parts = [];
      if (Number.isInteger(r.balance)) parts.push(fill(t('sparks_left', '{n} Sparks left.'), { n: r.balance }));
      if (r.emailed) parts.push(t('sparks_sheet_mail', 'The order confirmation is on its way by email.'));
      return parts.join(' ');
    }

    // After the hub said yes. False when the sheet was closed meanwhile, so the
    // dialog can tell the buyer another way.
    async function finish(r) {
      if (gone) return false;
      if (r.bought) {
        const from = held();
        flying = true;
        await Promise.all([motion.fly(offer.price.mark, bit), motion.count(from, r.balance, showHeld)]);
        flying = false;
      }
      if (gone) return false;
      result = r;
      busy(false);
      receipt.line.textContent = doneWords(r);
      receipt.line.hidden = !receipt.line.textContent;
      paint();
      if (player) player.play('celebrate');
      return true;
    }

    on(o.box, 'change', () => { asking = false; paint(); });
    on(pass.only, 'click', () => { chosen = true; paint(); });
    on(foot.have, 'click', () => { chosen = true; o.other.click(); });
    on(foot.back, 'click', () => { chosen = false; asking = false; o.onBack(); });
    const unwatch = credits() ? credits().onChange(paint) : null;
    if (credits()) credits().refresh(true);

    function destroy() {
      gone = true;
      stop.abort();
      motion.stop();
      if (unwatch) unwatch();
      if (window.BitApp) window.BitApp.sweep();
    }

    return { sync, askTick, busy, setHeld, finish, destroy };
  }

  window.BuySheet = { mount };
})();
