// Xenon credits, shared by every surface that shows them: the balance of this
// PC's supporter pass (or its Sparks code), the credits chip (Settings, Store, chat) and the switch
// to Xenon AI for supporters whose assistant has nothing to answer with.
// The pass and the hub's token stay on the server (ai-xenon-credits.js); this
// file only ever sees numbers.
(function () {
  const BALANCE_TTL_MS = 60000;
  // Rough credits per new widget for each Claude tier, the same figures the model
  // names quote; Sonnet and Opus as measured on real creations (26 Oct 2026).
  const WIDGET_COST = { haiku: 3, sonnet: 80, opus: 150 };
  const DEFAULT_MODEL = 'sonnet';
  // Below this the chip asks for a top-up: one Sonnet widget costs about 80.
  const LOW_CREDITS = 80;
  const TOPUP_URL = 'https://www.buymeacoffee.com/marcimastro98/extras';
  // Top-up packs (credits never expire). The bonus is what a pack adds over
  // 100 credits per USD, shown as a count, not a percentage.
  const PACKS = Object.freeze([
    { credits: 500, usd: 5 },
    { credits: 1050, usd: 10 },
    { credits: 2200, usd: 20, best: true },
  ]);

  // A purchase lands on the hub, not here: coming back to the dashboard or to
  // Bit's chat looks again, at most this often.
  const RECHECK_MS = 10000;
  // After a tap on a pack, the balance is asked this often for this long, so the
  // Sparks show up on their own (the hub books them within a minute).
  const WATCH_EVERY_MS = 15000;
  const WATCH_FOR_MS = 5 * 60000;

  const EMPTY = { status: 'idle', balance: null, included: null, monthly: null, topup: null, email: '' };
  let state = { ...EMPTY };
  let fetchedAt = 0;
  let askedAt = 0;
  let inflight = null;
  // {phase: 'waiting'|'arrived'|'late', got, baseline, until, timer} or null.
  let watch = null;
  let autoChecked = false;
  const listeners = new Set();

  const active = () => !!(typeof hubSettings === 'object' && hubSettings && hubSettings.aiProvider === 'xenon');

  function format(n) {
    const v = Number.isFinite(n) ? n : 0;
    return v.toLocaleString(typeof lang === 'string' ? lang : undefined, { maximumFractionDigits: v < 10 ? 1 : 0 });
  }

  function packBonus(p) { return Math.max(0, p.credits - p.usd * 100); }

  // The tier that answers on Sparks, and how many new widgets an amount pays for
  // with it: what a buyer gets, said in things rather than in credits.
  function model() {
    const m = typeof hubSettings === 'object' && hubSettings && hubSettings.xenonModel;
    return Object.prototype.hasOwnProperty.call(WIDGET_COST, m) ? m : DEFAULT_MODEL;
  }
  function widgetCost(m) { return WIDGET_COST[m || model()]; }
  function widgetsFor(credits, m) { return Math.floor((Number(credits) || 0) / widgetCost(m)); }

  function emit() {
    if (watch) checkWatch();
    renderChips();
    listeners.forEach((fn) => { try { fn(state); } catch { /* a listener never breaks the others */ } });
  }

  async function refresh(force) {
    if (!force && state.status === 'ok' && Date.now() - fetchedAt < BALANCE_TTL_MS) return state;
    // No code on this PC: asked once a minute at most, not on every repaint.
    if (!force && state.status === 'no_code' && Date.now() - askedAt < BALANCE_TTL_MS) return state;
    if (inflight) return inflight;
    askedAt = Date.now();
    if (state.status !== 'ok') { state = { ...state, status: 'loading' }; emit(); }
    inflight = (async () => {
      let out = null;
      try {
        const res = await fetch(SERVER + '/api/ai/xenon/balance', { cache: 'no-store' });
        out = res.ok ? await res.json() : null;
      } catch { out = null; }
      if (out && out.ok === true && Number.isFinite(out.balance)) {
        const email = typeof out.email === 'string' ? out.email : '';
        state = { status: 'ok', balance: out.balance, included: out.included, monthly: out.monthly, topup: out.topup, email };
        fetchedAt = Date.now();
      } else {
        const noCode = out && (out.error === 'no_code' || out.error === 'bad_code');
        state = { ...EMPTY, status: noCode ? 'no_code' : 'error' };
      }
      inflight = null;
      emit();
      return state;
    })();
    return inflight;
  }

  function recheck() {
    if (!active() || Date.now() - askedAt < RECHECK_MS) return;
    refresh(true);
  }

  // ── After a tap on a pack ──────────────────────────────────────────────────
  // The bought Sparks are top-up credits, so the watch compares those: the
  // included ones refill and drain on their own.
  function stopTimer() {
    if (watch && watch.timer) clearInterval(watch.timer);
    if (watch) watch.timer = null;
  }

  function checkWatch() {
    if (!watch || watch.phase !== 'waiting' || state.status !== 'ok' || !Number.isFinite(state.topup)) return;
    if (watch.baseline === null || state.topup < watch.baseline) { watch.baseline = state.topup; return; }
    if (state.topup > watch.baseline) {
      watch.got = Math.round(state.topup - watch.baseline);
      watch.phase = 'arrived';
      stopTimer();
      if (window.XenonToast) {
        window.XenonToast.show({
          type: 'success', kicker: 'Bit', important: true, duration: 9000,
          title: t('xai_buy_toast_title'),
          message: t('xai_buy_toast_msg').replace('{n}', format(watch.got)).replace('{balance}', format(state.balance)),
          onClick: openCredits,
        });
      }
    }
  }

  function watchTick() {
    if (!watch || watch.phase !== 'waiting') return;
    if (!active() || Date.now() >= watch.until) {
      watch.phase = active() ? 'late' : null;
      stopTimer();
      if (!watch.phase) watch = null;
      emit();
      return;
    }
    refresh(true);
  }

  function watchPurchase() {
    if (!active()) return;
    stopTimer();
    const baseline = state.status === 'ok' && Number.isFinite(state.topup) ? state.topup : null;
    watch = { phase: 'waiting', got: 0, baseline, until: Date.now() + WATCH_FOR_MS, timer: setInterval(watchTick, WATCH_EVERY_MS) };
    if (baseline === null) refresh(true);
    else emit();
  }

  const purchase = () => (watch ? { phase: watch.phase, got: watch.got } : null);

  // A turn on credits answers with the balance left; it is the freshest number
  // there is, so it replaces the cached one without another round trip.
  function set(balance) {
    if (!Number.isFinite(balance)) return;
    state = { ...state, status: 'ok', balance };
    fetchedAt = Date.now();
    emit();
  }

  function level() {
    if (state.status !== 'ok') return '';
    if (state.balance <= 0) return 'empty';
    return state.balance < LOW_CREDITS ? 'low' : 'ok';
  }

  // The credits chip. Any element with [data-xenon-credits] is painted by
  // renderChips(), so a copied chat pane or a rebuilt Store keeps working.
  // opts.always: shown whatever answers in the chat (Settings, the Store head).
  function chip(opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'xc-chip';
    b.setAttribute('data-xenon-credits', '');
    if (opts && opts.always) b.setAttribute('data-xc-always', '');
    b.hidden = true;
    paintChip(b);
    return b;
  }

  // The Scintilla, drawn by the shared engine (shared/src/bit-spark.js): it
  // twinkles now and then, and an empty balance shows it grey and asleep.
  function spark(opts) {
    const X = window.Xenon && window.Xenon.spark;
    if (!X) return document.createElement('span');
    const tpl = document.createElement('template');
    tpl.innerHTML = X.svg(opts);
    return tpl.content.firstElementChild;
  }

  // Every [data-xspark] placeholder in the page markup gets its spark. An offer
  // (data-xspark="offer") names Scintille you would get, so your balance never greys it.
  function paintSparks() {
    const dim = level() === 'empty';
    document.querySelectorAll('[data-xspark]').forEach((host) => host.replaceChildren(spark({ dim: dim && host.dataset.xspark !== 'offer' })));
    paintBitIcons();
  }

  // The spark beside Scintille someone would get (a plan, a perk). It is an
  // offer, so paintSparks() never greys it with the viewer's own balance.
  function offerMark() {
    const host = document.createElement('span');
    host.setAttribute('data-xspark', 'offer');
    host.setAttribute('aria-hidden', 'true');
    host.appendChild(spark());
    return host;
  }

  // One line of copy about Scintille someone would get, with its spark.
  function offerLine(text, className) {
    const line = document.createElement('p');
    line.className = className ? 'xc-offer ' + className : 'xc-offer';
    const words = document.createElement('span');
    words.textContent = text;
    line.append(offerMark(), words);
    return line;
  }

  // The three packs as one row of buttons, the same in Settings, the Store and
  // the chat; `btnClass` gives them the look of the surface they sit on. A little
  // heap of still Scintille grows with the pack (one, two, three), then the
  // amount, the price and any bonus. Plain links, so a copied chat pane keeps
  // working: the click is delegated below.
  function packSparks(count) {
    const heap = document.createElement('span');
    heap.className = 'xai-pack-sparks';
    heap.dataset.count = String(count);
    heap.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < count; i += 1) heap.appendChild(spark({ still: true }));
    return heap;
  }

  function packButton(p, i, btnClass) {
    const a = document.createElement('a');
    a.className = (btnClass || 'settings-btn') + ' xai-pack';
    a.href = TOPUP_URL;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('data-xc-pack', String(p.credits));
    const n = document.createElement('b');
    n.textContent = t('xai_pack_credits').replace('{n}', format(p.credits));
    const price = document.createElement('span');
    price.className = 'xai-pack-price';
    price.textContent = t('xai_pack_price').replace('{n}', String(p.usd));
    // The amount with its gift on top, the price and what it makes below.
    const head = document.createElement('span');
    head.className = 'xai-pack-line';
    head.appendChild(n);
    const bonus = packBonus(p);
    if (bonus > 0) {
      const extra = document.createElement('span');
      extra.className = 'xai-pack-bonus';
      extra.textContent = t('xai_pack_bonus').replace('{n}', format(bonus));
      head.appendChild(extra);
    }
    const reach = document.createElement('span');
    reach.className = 'xai-pack-reach';
    reach.dataset.xcReach = String(p.credits);
    paintReach(reach);
    const line = document.createElement('span');
    line.className = 'xai-pack-line';
    line.append(price, reach);
    const words = document.createElement('span');
    words.className = 'xai-pack-words';
    words.append(head, line);
    a.append(packSparks(i + 1), words);
    return a;
  }

  function paintReach(node) {
    node.textContent = t('xai_pack_reach').replace('{n}', format(widgetsFor(node.dataset.xcReach)));
  }

  function packList(btnClass) {
    const list = document.createElement('div');
    list.className = 'xai-pack-list';
    PACKS.forEach((p, i) => list.appendChild(packButton(p, i, btnClass)));
    return list;
  }

  // The provider chip wears Bit's face: Bit is the name there, the spark is only the money.
  // bit-app.js loads after this file, so a paint made before it is repeated on load.
  function paintBitIcons() {
    if (!window.BitApp) return;
    const markup = BitApp.icon('idle');
    if (!markup) return;
    document.querySelectorAll('[data-bit-icon]').forEach((host) => { host.innerHTML = markup; });
  }

  // A chip marked [data-xc-always] shows the Sparks to everyone: the balance
  // when this PC holds a code, else the word and Buy, the way into the shop.
  // The chat's chip shows only while Bit answers on Sparks.
  function paintChip(b) {
    const always = b.hasAttribute('data-xc-always');
    if (always && state.status === 'idle') queueMicrotask(() => refresh(false));
    const known = state.status === 'ok';
    const show = always ? (known || state.status === 'no_code' || state.status === 'error') : active() && known;
    b.hidden = !show;
    if (!show) return;
    if (!known) { paintChipUnknown(b); return; }
    const lv = level();
    b.dataset.level = lv;
    const ic = spark({ dim: lv === 'empty' });
    const num = document.createElement('b');
    num.textContent = format(state.balance);
    const unit = document.createElement('span');
    unit.textContent = t('xc_chip_unit');
    const parts = [ic, num, unit];
    if (lv === 'low' || lv === 'empty') {
      const cta = document.createElement('span');
      cta.className = 'xc-chip-cta';
      cta.textContent = t('xc_chip_topup');
      parts.push(cta);
    }
    b.replaceChildren(...parts);
    const title = t('xc_chip_title').replace('{n}', format(state.balance));
    b.title = title;
    b.setAttribute('aria-label', title);
  }

  function paintChipUnknown(b) {
    delete b.dataset.level;
    const unit = document.createElement('span');
    unit.textContent = t('xc_chip_unit');
    const cta = document.createElement('span');
    cta.className = 'xc-chip-cta';
    cta.textContent = t('xc_chip_topup');
    b.replaceChildren(spark(), unit, cta);
    const title = t('xc_chip_title_none');
    b.title = title;
    b.setAttribute('aria-label', title);
  }

  function renderChips() {
    document.querySelectorAll('[data-xenon-credits]').forEach(paintChip);
    // The packs' "about N widgets" follows the tier picked in Settings.
    document.querySelectorAll('[data-xc-reach]').forEach(paintReach);
    paintSparks();
    // The model button sits beside the chip in Bit's chat head, shown on the same terms.
    if (window.BitChatModel) window.BitChatModel.paint();
  }

  // A chip anywhere leads to Settings → Xenon AI, whose first rows are the
  // credits and the packs (or the offer, off Xenon AI).
  function openCredits() {
    if (typeof openSettings === 'function') openSettings('ai');
    requestAnimationFrame(() => {
      const group = document.querySelector('.settings-ai-group');
      if (group) group.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
  // Where Sparks are bought: the Store's Sparks tab, which says what they are
  // for. Without the Store (a trimmed build) the shop page opens instead.
  function openShop() {
    if (window.CommunityGallery && typeof window.CommunityGallery.openSparks === 'function') {
      window.CommunityGallery.openSparks();
      return;
    }
    window.open(TOPUP_URL, '_blank', 'noopener');
  }
  document.addEventListener('click', (e) => {
    const c = e.target && e.target.closest && e.target.closest('[data-xenon-credits]');
    if (!c) return;
    e.preventDefault();
    e.stopPropagation();
    openShop();
  });
  // A tap on a pack anywhere (the link opens the shop) starts the wait for its Sparks.
  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-xc-pack]')) watchPurchase();
  });

  function useXenon() {
    if (typeof hubSettings !== 'object' || !hubSettings || hubSettings.aiProvider === 'xenon') return;
    hubSettings = normalizeSettings({ ...hubSettings, aiProvider: 'xenon' });
    saveHubSettings();
    if (typeof syncAiProviderControls === 'function') syncAiProviderControls();
    if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
    refresh(true);
  }

  // A Sparks code (XC) saved on this PC: Sparks bought without being a supporter.
  async function sparksCodeSaved() {
    try {
      const res = await fetch(SERVER + '/api/community/sparks', { cache: 'no-store' });
      const out = await res.json();
      return !!(out && out.wallet === true);
    } catch { return false; }
  }

  async function supporterSaved() {
    try {
      const res = await fetch(SERVER + '/api/community/supporter', { cache: 'no-store' });
      const out = await res.json();
      return !!(out && out.saved);
    } catch { return false; }
  }

  // Supporters get Xenon AI without looking for it: when the pass is on this PC
  // and the chosen assistant cannot answer (the default Gemini with no key, a
  // ChatGPT or Claude provider without its key), the credits take over. A
  // working provider the user set up is never replaced.
  async function autoSelectForSupporter(force) {
    if (autoChecked && !force) return false;
    autoChecked = true;
    if (typeof hubSettings !== 'object' || !hubSettings || hubSettings.aiProvider === 'xenon') return false;
    if (typeof _aiHasKey !== 'function' || _aiHasKey()) return false;
    if (!(await supporterSaved())) return false;
    if (typeof _aiHasKey === 'function' && _aiHasKey()) return false; // set up meanwhile
    useXenon();
    return true;
  }

  // Called whenever the AI settings may have changed (provider, keys, a sync
  // from another surface): repaint the chips and fetch the balance when shown.
  function sync() {
    renderChips();
    // Settings and the Store show the Sparks to everyone, so they are read even off Bit.
    if (active() || document.querySelector('[data-xc-always]')) refresh(false);
    autoSelectForSupporter(false);
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // Back from the shop in another tab or app, or into Bit's chat: look again.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recheck(); });
  window.addEventListener('focus', recheck);
  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-chatf="pane"]')) recheck();
  });

  paintSparks();
  window.addEventListener('load', paintBitIcons);

  window.XenonCredits = {
    PACKS, TOPUP_URL, LOW_CREDITS, WIDGET_COST,
    get state() { return state; },
    active, refresh, recheck, set, sync, chip, spark, offerMark, offerLine, packList, renderChips, level, format, packBonus, model, widgetCost, widgetsFor,
    openCredits, openShop, useXenon, supporterSaved, sparksCodeSaved, autoSelectForSupporter, onChange, watchPurchase, purchase,
  };
})();
