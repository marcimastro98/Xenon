'use strict';
// The Store's Sparks tab: where Sparks are bought, and what they are for.
// Every "Buy Sparks" in the app lands here (XenonCredits.openShop), so the
// packs, the email a purchase must use and the wait for a purchase live in one
// place. Catalog entries arrive through the Store (ctx.catalog) and are drawn
// with the Store's own card (ctx.renderCard): catalog text never reaches
// innerHTML here; only the engine's own Bit and spark markup does.
(function () {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const el = makeEl; // shared DOM factory from utils.js
  const MAKER_URL = 'https://xenon-app.com/maker/';
  // Sparks each supporter month includes (the hub's AI_INCLUDED_CREDITS), as
  // the offer lines say it.
  const MONTHLY = 300;
  // The monthly membership on Buy Me a Coffee, in US dollars.
  const MEMBER_USD = 5;
  // A Store entry Sparks open: priced, and not a limited edition (never sold).
  const soldForSparks = (e) => !!e && !e.limited && Number.isInteger(e.sparks) && e.sparks > 0;

  function C() { return window.XenonCredits; }
  function fmt(n) { return C() ? C().format(n) : String(n); }
  function models() { return C() && C().WIDGET_COST ? Object.keys(C().WIDGET_COST) : []; }
  function modelName(m) { return t('xai_model_' + m); }

  // The line under the name says what Sparks do here: Bit always, the Store
  // only while it sells something for them.
  function hero(state, sellsItems) {
    const head = el('div', 'sparks-hero');
    const mark = el('span', 'sparks-hero-mark');
    mark.setAttribute('aria-hidden', 'true');
    if (C()) mark.appendChild(C().spark());
    const words = el('div', 'sparks-hero-words');
    words.appendChild(el('h3', 'sparks-hero-title', t('xai_balance_unit', 'Sparks')));
    words.appendChild(el('p', 'sparks-hero-sub', t(sellsItems ? 'sparks_shop_sub' : 'sparks_shop_sub_bit')));
    head.append(mark, words);
    if (state && state.status === 'ok') {
      const bal = el('p', 'sparks-hero-balance');
      bal.setAttribute('role', 'status');
      if (C()) bal.appendChild(C().spark({ dim: C().level() === 'empty' }));
      bal.appendChild(el('b', null, fmt(state.balance)));
      bal.appendChild(el('span', null, t('sparks_shop_yours')));
      head.appendChild(bal);
    }
    return head;
  }

  // The pack that gives the most Sparks per dollar: a fact the prices show.
  function bestPack(packs) {
    return packs.reduce((best, p) => (!best || p.credits / p.usd > best.credits / best.usd ? p : best), null);
  }

  // Each pack says what it makes with every model, not only the one picked:
  // a buyer may switch, and the counts differ by fifty times.
  function dressPack(a, pack, best) {
    const reach = a.querySelector('.xai-pack-reach');
    if (reach) reach.remove();
    const list = el('ul', 'sparks-pack-models');
    models().forEach((m) => {
      const row = el('li');
      row.appendChild(el('span', null, modelName(m)));
      row.appendChild(el('b', null, t('xai_pack_reach').replace('{n}', fmt(C().widgetsFor(pack.credits, m)))));
      list.appendChild(row);
    });
    a.appendChild(list);
    if (pack === best) {
      a.classList.add('is-best');
      a.insertBefore(el('span', 'sparks-pack-best', t('sparks_shop_best')), a.firstChild);
    }
  }

  // The packs, big, with the line that says which email pays and what the last
  // purchase made from here is doing.
  function packs(state, owner) {
    const box = el('section', 'sparks-block sparks-packs');
    const head = el('div', 'sparks-block-head');
    head.appendChild(el('h4', 'sparks-block-title', t('sparks_shop_packs')));
    head.appendChild(el('span', 'sparks-block-hint', t('xai_packs_hint')));
    box.appendChild(head);
    if (C()) {
      const list = C().packList('cgal-btn sparks-pack');
      const best = bestPack(C().PACKS);
      Array.from(list.children).forEach((a, i) => dressPack(a, C().PACKS[i], best));
      box.appendChild(list);
    }
    const pay = el('p', 'sparks-note');
    pay.textContent = state && state.email
      ? t('xai_packs_email').replace('{email}', state.email)
      : t(owner.any ? 'xai_packs_note' : 'sparks_shop_code_note');
    box.appendChild(pay);
    const status = el('p', 'sparks-note sparks-status');
    status.setAttribute('role', 'status');
    paintStatus(status);
    box.appendChild(status);
    return box;
  }

  function paintStatus(node) {
    const p = C() && C().purchase();
    node.hidden = !p;
    if (!p) return;
    node.classList.toggle('is-warn', p.phase === 'late');
    node.textContent = p.phase === 'arrived'
      ? t('xai_buy_arrived').replace('{n}', fmt(p.got))
      : t(p.phase === 'late' ? 'xai_buy_late' : 'xai_buy_waiting');
  }

  // The supporter membership as one plan: what it costs, what a month brings,
  // one action. The Store's Supporters shelf and this tab draw the same card,
  // so the offer reads the same wherever it is met. A PC that keeps a supporter
  // code reads that it is included, with no button to join again.
  // opts: { supporter, href, icon(name), primary }
  function plan(opts) {
    const mine = !!opts.supporter;
    const box = el('section', 'sparks-plan' + (mine ? ' is-mine' : ''));
    const lead = el('div', 'sparks-plan-lead');
    lead.appendChild(el('h4', 'sparks-plan-name', t('sparks_plan_name')));
    lead.appendChild(el('p', 'sparks-plan-price', mine ? t('sparks_plan_mine') : t('sparks_plan_price').replace('{usd}', String(MEMBER_USD))));
    const facts = el('ul', 'sparks-plan-facts');
    const fact = (mark, text) => {
      const li = el('li');
      if (mark) { mark.setAttribute('aria-hidden', 'true'); li.appendChild(mark); }
      li.appendChild(el('span', null, text));
      facts.appendChild(li);
    };
    fact(C() ? C().spark({ still: true }) : null, t('sparks_plan_sparks').replace('{n}', fmt(MONTHLY)));
    fact(opts.icon('supporters'), t('sparks_plan_packs'));
    fact(opts.icon('check'), t('sparks_plan_keep'));
    box.append(lead, facts);
    if (mine) return box;
    const go = document.createElement('a');
    go.className = 'cgal-btn sparks-plan-btn' + (opts.primary ? ' primary' : '');
    go.href = opts.href;
    go.target = '_blank';
    go.rel = 'noopener noreferrer';
    go.textContent = t('gallery_supporters_join');
    box.appendChild(go);
    return box;
  }

  function useCard(opts) {
    const card = el('article', 'sparks-use');
    const art = el('span', 'sparks-use-art');
    art.setAttribute('aria-hidden', 'true');
    if (opts.art) art.appendChild(opts.art);
    card.appendChild(art);
    card.appendChild(el('h5', 'sparks-use-title', opts.title));
    card.appendChild(el('p', 'sparks-use-text', opts.text));
    if (opts.value) card.appendChild(el('p', 'sparks-use-value', opts.value));
    if (opts.action) card.appendChild(opts.action);
    return card;
  }

  function button(label, onClick) {
    const b = el('button', 'cgal-btn sparks-use-btn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function bitArt() {
    const host = el('span', 'sparks-bit');
    const markup = window.BitApp && typeof window.BitApp.icon === 'function' ? window.BitApp.icon('idle') : '';
    if (markup) host.innerHTML = markup; // the engine's own SVG, no catalog text
    return host;
  }

  // Bit answers on Sparks only with Bit as the provider: the button turns that
  // on first, then opens the chat.
  function openBit(close) {
    if (C() && !C().active()) C().useXenon();
    close();
    if (typeof window.openMediaChat === 'function') window.openMediaChat();
    else if (typeof window.openAiPanel === 'function') window.openAiPanel();
  }

  // What one widget costs with each model, in one sentence.
  function costLine() {
    let line = t('sparks_use_bit_v');
    models().forEach((m) => { line = line.replace('{' + m + '}', fmt(C().widgetCost(m))); });
    return line;
  }

  function uses(ctx, items) {
    const box = el('section', 'sparks-block');
    const head = el('div', 'sparks-block-head');
    head.appendChild(el('h4', 'sparks-block-title', t('sparks_shop_uses')));
    box.appendChild(head);
    const grid = el('div', 'sparks-uses');
    grid.appendChild(useCard({
      art: bitArt(),
      title: t('sparks_use_bit_t'),
      text: t('sparks_use_bit_d'),
      value: C() ? costLine() : '',
      action: button(t('sparks_use_bit_cta'), () => openBit(ctx.close)),
    }));
    if (items.length) {
      grid.appendChild(useCard({
        art: ctx.icon('store'),
        title: t('sparks_use_store_t'),
        text: t('sparks_use_store_d'),
        action: button(t('sparks_use_store_cta'), () => {
          const rail = box.querySelector('.sparks-items');
          if (rail) rail.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }),
      }));
    }
    const maker = document.createElement('a');
    maker.className = 'cgal-btn sparks-use-btn';
    maker.href = MAKER_URL;
    maker.target = '_blank';
    maker.rel = 'noopener noreferrer';
    maker.textContent = t('sparks_use_maker_cta');
    grid.appendChild(useCard({ art: ctx.icon('page'), title: t('sparks_use_maker_t'), text: t('sparks_use_maker_d'), action: maker }));
    box.appendChild(grid);
    if (items.length) {
      const shelf = el('div', 'sparks-items');
      shelf.appendChild(el('h4', 'sparks-block-title', t('sparks_shop_items')));
      const rail = el('div', 'cgal-hrail');
      items.forEach((e) => rail.appendChild(ctx.renderCard(e, true)));
      shelf.appendChild(rail);
      box.appendChild(shelf);
    }
    return box;
  }

  // ctx: { catalog(): Promise<entries>, renderCard(entry, noId), icon(name), supportHref(src), close() }
  async function render(body, ctx) {
    const root = el('div', 'sparks-shop');
    body.replaceChildren(root);
    const credits = C();
    if (credits) credits.refresh(false);
    const [supporter, wallet, entries] = await Promise.all([
      credits ? credits.supporterSaved() : false,
      credits ? credits.sparksCodeSaved() : false,
      ctx.catalog().catch(() => []),
    ]);
    if (!root.isConnected) return;
    const owner = { supporter, any: supporter || wallet };
    const items = (Array.isArray(entries) ? entries : []).filter(soldForSparks);
    const state = credits ? credits.state : null;
    root.replaceChildren(hero(state, items.length > 0), packs(state, owner), plan({ supporter: owner.supporter, href: ctx.supportHref('sparks-shop'), icon: ctx.icon, primary: true }), uses(ctx, items));
    // A purchase landing or a new balance repaints the tab while it is open.
    if (credits) {
      const off = credits.onChange(() => {
        if (!root.isConnected) { off(); return; }
        const status = root.querySelector('.sparks-status');
        if (status) paintStatus(status);
        if (credits.state.status !== 'ok') return;
        const bal = root.querySelector('.sparks-hero-balance b');
        if (bal) bal.textContent = fmt(credits.state.balance);
        else root.querySelector('.sparks-hero').replaceWith(hero(credits.state, items.length > 0)); // the first balance read
      });
    }
  }

  window.SparksStore = { render, plan, soldForSparks, MAKER_URL };
})();
