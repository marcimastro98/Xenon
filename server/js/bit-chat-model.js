// The balance in Bit's chat head, and what it opens. On the Scintille the head
// shows the spark and the Scintille left; a tap opens a small panel under the
// head with the balance, the way to more, and the three creation models with
// what a widget costs on each. The model is the same setting as Settings → Bit,
// saved by js/ai-xenon-settings.js (the reasoning stays in Settings). Every copy
// of the chat tile has its own head, so the buttons are painted by attribute
// and handled by one listener on the document.
(function () {
  const BTN = '[data-bit-model]';
  const PANEL = '[data-bit-model-panel]';
  const PICK = '[data-bit-pick]';
  const TOPUP = '[data-bit-topup]';

  const settings = () => window.XenonCreditsSettings;
  const credits = () => window.XenonCredits;
  const shown = () => !!(credits() && credits().active() && settings());
  const balance = () => {
    const s = credits() && credits().state;
    return s && s.status === 'ok' && Number.isFinite(s.balance) ? s.balance : null;
  };
  const spark = () => (credits() && credits().spark ? credits().spark({ still: true }) : document.createElement('span'));

  function panelFor(btn) {
    const pane = btn.closest('[data-chatf="pane"]');
    return pane ? pane.querySelector(PANEL) : null;
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // "377 Scintille" and Ricarica, the way to the Store's Sparks tab.
  function topRow() {
    const row = el('div', 'bit-model-top');
    const left = balance();
    const amount = el('span', 'bit-model-balance');
    amount.append(spark(), el('b', '', left == null ? t('xc_chip_unit') : t('xai_pack_credits').replace('{n}', credits().format(left))));
    const topup = el('button', 'bit-model-topup', t('bit_model_topup'));
    topup.type = 'button';
    topup.dataset.bitTopup = '';
    row.append(amount, topup);
    return row;
  }

  // One row per model: its plain name, and what a widget costs on it.
  function modelOption(m, current) {
    const b = el('button', 'bit-model-opt');
    b.type = 'button';
    b.dataset.bitPick = 'model';
    b.dataset.value = m;
    b.setAttribute('aria-pressed', String(m === current));
    const cost = credits() && credits().widgetCost ? credits().widgetCost(m) : null;
    b.append(el('span', 'bit-model-opt-name', t('xai_model_' + m)));
    if (Number.isFinite(cost)) b.append(el('small', '', t('bit_model_cost').replace('{n}', credits().format(cost))));
    return b;
  }

  function fill(panel) {
    const S = settings();
    const current = S.currentModel();
    const list = el('div', 'bit-model-list');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', t('bit_model_who'));
    S.MODELS.forEach((m) => list.appendChild(modelOption(m, current)));
    panel.replaceChildren(
      topRow(),
      el('span', 'bit-model-label', t('bit_model_who')),
      list,
      el('p', 'bit-model-note', t('bit_model_ask_cost')),
    );
  }

  function setOpen(btn, open) {
    const panel = panelFor(btn);
    btn.setAttribute('aria-expanded', String(open));
    if (!panel) return;
    if (open) fill(panel);
    panel.hidden = !open;
  }

  function closeAll(except) {
    document.querySelectorAll(BTN).forEach((b) => {
      if (b !== except && b.getAttribute('aria-expanded') === 'true') setOpen(b, false);
    });
  }

  function paintButton(b) {
    const left = balance();
    const num = b.querySelector('[data-bit-model-name]');
    if (num) num.textContent = left == null ? '' : credits().format(left);
    const sparkHost = b.querySelector('[data-bit-model-spark]');
    if (sparkHost) sparkHost.replaceChildren(spark());
    const title = left == null ? t('bit_balance_title_none') : t('bit_balance_title').replace('{n}', credits().format(left));
    b.title = title;
    b.setAttribute('aria-label', title);
  }

  // The card shown while nothing can answer names the first pack, so its price
  // comes from XenonCredits.PACKS and never drifts from the shop.
  function paintNokey() {
    const pack = credits() && credits().PACKS && credits().PACKS[0];
    if (!pack) return;
    const line = t('bit_nokey_line').replace('{credits}', credits().format(pack.credits)).replace('{usd}', String(pack.usd));
    document.querySelectorAll('[data-bit-nokey-line]').forEach((n) => { n.textContent = line; });
  }

  // Cheap and idempotent: called whenever the balance or the AI settings may
  // have changed (renderChips, a sync from another surface, the language, a pick).
  function paint() {
    paintNokey();
    const on = shown();
    document.querySelectorAll(BTN).forEach((b) => {
      b.hidden = !on;
      if (!on) { if (b.getAttribute('aria-expanded') === 'true') setOpen(b, false); return; }
      paintButton(b);
      if (b.getAttribute('aria-expanded') === 'true') { const p = panelFor(b); if (p) fill(p); }
    });
  }

  function pick(choice) {
    const S = settings();
    if (!S || choice.dataset.bitPick !== 'model') return;
    S.onModelSelect(choice.dataset.value);
    S.renderModels(); // the Settings selects show the same choice
    paint();
  }

  document.addEventListener('click', (e) => {
    const target = e.target && e.target.closest ? e.target : null;
    if (!target) return;
    const btn = target.closest(BTN);
    if (btn) {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      closeAll(btn);
      setOpen(btn, open);
      return;
    }
    if (target.closest(TOPUP)) {
      closeAll(null);
      if (credits() && credits().openShop) credits().openShop();
      return;
    }
    const choice = target.closest(PICK);
    if (choice) { pick(choice); return; }
    if (!target.closest(PANEL)) closeAll(null);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll(BTN)].find((b) => b.getAttribute('aria-expanded') === 'true');
    if (!open) return;
    e.preventDefault(); // one Escape closes the panel, not the phone's full-screen chat too
    setOpen(open, false);
    open.focus();
  });

  window.BitChatModel = { paint };
})();
