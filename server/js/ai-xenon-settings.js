// Settings → Xenon AI: the credits rows at the top of the page and the Claude
// tier that answers. On Xenon AI the rows show the balance, this month's
// included credits and the top-up packs; on any other provider one row offers
// Xenon AI (switch to it for a supporter, the pass for everyone else). The numbers
// come from js/xenon-credits.js; the pass itself never reaches this page.
(function () {
  const MODELS = ['haiku', 'sonnet', 'opus'];
  const DEFAULT_MODEL = 'sonnet';
  // How hard the creation model reasons; the dearer the level, the more credits.
  const EFFORTS = ['low', 'medium', 'high'];
  const DEFAULT_EFFORT = 'medium';
  const SUPPORT_URL = 'https://xenon-supporter-hub.xenonedge.workers.dev/go/support?s=ai';
  let supporter = null; // null = not asked yet
  let wallet = false; // a Sparks code (XC) on this PC, asked with `supporter`
  let offerSeq = 0;

  const $id = (id) => document.getElementById(id);
  const show = (id, on) => { const el = $id(id); if (el) el.hidden = !on; };
  const currentModel = () => (MODELS.includes(hubSettings && hubSettings.xenonModel) ? hubSettings.xenonModel : DEFAULT_MODEL);
  const currentEffort = () => (EFFORTS.includes(hubSettings && hubSettings.xenonEffort) ? hubSettings.xenonEffort : DEFAULT_EFFORT);
  const fmt = (n) => window.XenonCredits.format(n);

  function fillSelect(id, values, key, current) {
    const sel = $id(id);
    if (!sel) return;
    sel.replaceChildren(...values.map((v) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t(key + v);
      return o;
    }));
    sel.value = current;
  }

  function renderModels() {
    fillSelect('settings-xenon-model', MODELS, 'settings_xenon_model_', currentModel());
    fillSelect('settings-xenon-effort', EFFORTS, 'settings_xenon_effort_', currentEffort());
  }

  function renderBalance(st) {
    const num = $id('settings-xenon-balance');
    const note = $id('settings-xenon-split');
    const low = $id('xai-low');
    if (!num || !note || !low) return;
    const ok = st.status === 'ok';
    const waiting = st.status === 'loading' || st.status === 'idle';
    num.textContent = ok ? fmt(st.balance) : waiting ? '…' : '';
    num.parentElement.hidden = !ok && !waiting;
    note.hidden = false;
    // What the Sparks are for, in what this balance buys with the tier picked below.
    const C = window.XenonCredits;
    const included = $id('xai-included');
    if (ok) {
      const model = currentModel();
      const widgets = C.widgetsFor(st.balance, model);
      const name = t('xai_model_' + model);
      note.textContent = widgets >= 1
        ? t('xai_reach_line').replace('{balance}', fmt(st.balance)).replace('{n}', fmt(widgets)).replace('{model}', name)
        : t('xai_reach_cost').replace('{model}', name).replace('{cost}', fmt(C.widgetCost(model)));
    } else {
      note.textContent = t(st.status === 'no_code' ? 'settings_xenon_no_code' : st.status === 'error' ? 'settings_xenon_error' : 'settings_xenon_loading');
    }
    // The bar is this month's included credits still left.
    const meterOn = ok && Number.isFinite(st.monthly) && st.monthly > 0;
    if (included) {
      included.hidden = !meterOn;
      if (meterOn) {
        const now = new Date();
        const back = new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString(typeof lang === 'string' ? lang : undefined, { day: 'numeric', month: 'long' });
        included.textContent = t('xai_included').replace('{included}', fmt(st.included)).replace('{monthly}', fmt(st.monthly)).replace('{date}', back);
      }
    }
    show('xai-meter', meterOn);
    const fill = $id('xai-meter-fill');
    if (fill && meterOn) fill.style.setProperty('--fill', String(Math.max(0, Math.min(1, (st.included || 0) / st.monthly))));
    const lv = window.XenonCredits.level();
    low.hidden = lv !== 'low' && lv !== 'empty';
    low.textContent = t(lv === 'empty' ? 'xai_empty' : 'xai_low');
    renderPurchase();
  }

  // The packs are sold in the Store's Sparks tab; this row keeps what happened
  // to the last purchase, wherever it was made.
  function renderPurchase() {
    const status = $id('xai-buy-status');
    if (!status) return;
    const p = window.XenonCredits.purchase();
    status.hidden = !p;
    if (!p) return;
    status.classList.toggle('settings-note-warn', p.phase === 'late');
    status.textContent = p.phase === 'arrived'
      ? t('xai_buy_arrived').replace('{n}', fmt(p.got))
      : t(p.phase === 'late' ? 'xai_buy_late' : 'xai_buy_waiting');
  }

  async function renderOffer() {
    const mine = ++offerSeq;
    if (supporter === null) {
      [supporter, wallet] = await Promise.all([window.XenonCredits.supporterSaved(), window.XenonCredits.sparksCodeSaved()]);
    }
    if (mine !== offerSeq) return;
    const title = $id('xai-offer-title');
    const line = $id('xai-offer-line');
    if (!title || !line) return;
    // Someone with Sparks of their own (a pass or a Sparks code) just turns them on.
    const hasSparks = supporter || wallet;
    const which = supporter ? '_sup' : wallet ? '_wallet' : '';
    title.textContent = t('xai_offer_title' + which);
    line.textContent = t('xai_offer_line' + which);
    show('xai-use', hasSparks);
    show('xai-support', !hasSparks);
    show('xai-have-code', !hasSparks);
    const link = $id('xai-support');
    if (link) link.href = SUPPORT_URL;
  }

  // Paints the card for the provider in use; cheap, safe to call on every change.
  function render() {
    const on = window.XenonCredits && window.XenonCredits.active();
    show('settings-xenon-credits', on);
    show('xai-packs', on);
    show('xai-offer', !on);
    if (!window.XenonCredits) return;
    if (on) renderBalance(window.XenonCredits.state);
    else renderOffer();
  }

  async function refresh() {
    renderModels();
    supporter = null; // the pass may have been saved or removed since
    render();
    if (window.XenonCredits && window.XenonCredits.active()) await window.XenonCredits.refresh(true);
  }

  function onModelSelect(value) {
    if (!MODELS.includes(value)) return;
    hubSettings = normalizeSettings({ ...hubSettings, xenonModel: value });
    saveHubSettings();
    render();
    // The packs' "about N widgets" and the chat's model button follow the new tier.
    if (window.XenonCredits) window.XenonCredits.renderChips();
  }

  function onEffortSelect(value) {
    if (!EFFORTS.includes(value)) return;
    hubSettings = normalizeSettings({ ...hubSettings, xenonEffort: value });
    saveHubSettings();
    if (window.BitChatModel) window.BitChatModel.paint();
  }

  if (window.XenonCredits) window.XenonCredits.onChange(() => render());

  window.XenonCreditsSettings = {
    refresh, render, renderModels, onModelSelect, onEffortSelect, currentModel, currentEffort,
    MODELS, DEFAULT_MODEL, EFFORTS, DEFAULT_EFFORT,
  };
})();
