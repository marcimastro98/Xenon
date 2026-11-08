// The choices of one widget in edit mode, beside it on the screen: its name, when it
// shows, its size, tabs, and the way off the screen. Words, not loose icons: the x, the
// pin and a line that grew the widget are what this replaced. Loaded by js/layer-edit.js
// the first time a widget is tapped; every choice is a capability run on the server.
(function () {
  'use strict';

  const EDGE_PX = 8;       // kept clear of the screen's edge
  const TAG_PX = 30;       // the tag on the frame sits between the widget and the card
  const SITUATIONS = Object.freeze(['music', 'live']);

  let ctx = null;
  let node = null;
  let open = '';           // 'when', 'tabs' or ''
  let shownKey = '';

  function button(className, text, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;   // a Store widget's name is untrusted text
    b.addEventListener('click', onClick);
    return b;
  }

  function toggle(which) {
    open = open === which ? '' : which;
    ctx.closeSheet();
    fill();
  }

  function choose(action) {
    open = '';
    ctx.run(action);
    ctx.closed();
  }

  function row(label, sub, on, onClick) {
    const b = button('layer-edit-card-row', label, onClick);
    b.setAttribute('aria-pressed', String(on));
    if (sub) {
      const line = document.createElement('span');
      line.textContent = sub;
      b.appendChild(line);
    }
    return b;
  }

  function seeRow(w, see) {
    const label = ctx.tr('see_' + see, see);
    const sub = ctx.tr(`see_${see}_sub`, '');
    const on = window.LayerSee.seeOf(w) === see;
    return row(label, sub, on, () => {
      if (see === 'app') {
        open = '';
        ctx.closed();
        ctx.attach(w.id);
        return;
      }
      choose({ type: 'layerMove', target: w.id, ...window.LayerSee.changeFor(see) });
    });
  }

  function situationRow(w, c) {
    const rule = w.when && !w.when.hide && w.when.any.length === 1 ? w.when.any[0].c : '';
    return row(ctx.tr('xmenu_sit_' + c, c), '', rule === c, () => choose({ type: 'layerMove', target: w.id, when: c }));
  }

  function whenMenu(w) {
    const see = window.LayerSee.CHOICES.filter((c) => c !== 'app' || ctx.canAttach());
    return [...see.map((c) => seeRow(w, c)), ...SITUATIONS.map((c) => situationRow(w, c))];
  }

  // Every tab of this box joins the other, the one shown last so it opens.
  async function join(entry, target) {
    open = '';
    const members = entry.box.members.map((w) => w.id).sort((a, b) => (a === entry.shown) - (b === entry.shown));
    for (const id of members) {
      const res = await ctx.run({ type: 'layerGroup', widget: id, with: target.box.lead.id, mode: 'join' });
      if (!(res && res.ok)) break;
    }
    ctx.closed();
  }

  function tabsMenu(entry) {
    return ctx.others(entry).map((o) => row(ctx.nameOf(o.box.lead), '', false, () => join(entry, o)));
  }

  function sizes(w) {
    const ids = window.LayerSee.sizesOf(w);
    if (!ids.length) return null;
    const group = document.createElement('div');
    group.className = 'layer-edit-card-sizes';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', ctx.tr('xmenu_size', 'Size'));
    const now = window.LayersModel.nearestSize(w.rect, ids);
    [['xmenu_size_small', 'Small'], ['xmenu_size_medium', 'Medium'], ['xmenu_size_large', 'Large']].forEach(([key, word], i) => {
      const b = button('layer-edit-card-size', ctx.tr(key, word), () => ctx.run({ type: 'layerMove', target: w.id, size: ids[i], position: 'keep' }));
      b.setAttribute('aria-pressed', String(ids[i] === now));
      group.appendChild(b);
    });
    return group;
  }

  function fill() {
    const entry = ctx.entry();
    if (!entry) { hide(); return; }
    const w = entry.box.lead;
    const name = document.createElement('b');
    name.textContent = ctx.nameOf(w);
    const when = button('layer-edit-card-btn', ctx.tr('see_when', 'When: {what}').replace('{what}', ctx.tagOf(w)), () => toggle('when'));
    when.setAttribute('aria-expanded', String(open === 'when'));
    const parts = [name, when, sizes(w)];
    if (ctx.others(entry).length) {
      const tabs = button('layer-edit-card-btn', ctx.tr('see_tabs', 'Tabs with...'), () => toggle('tabs'));
      tabs.setAttribute('aria-expanded', String(open === 'tabs'));
      parts.push(tabs);
    }
    parts.push(button('layer-edit-card-btn layer-edit-card-btn--off', ctx.tr('see_remove', 'Remove'), () => choose({ type: 'layerRemove', target: entry.shown })));
    node.replaceChildren(...parts.filter(Boolean));
    if (open) node.appendChild(menu(open === 'when' ? whenMenu(w) : tabsMenu(entry)));
    place(entry);
  }

  function menu(rows) {
    const list = document.createElement('div');
    list.className = 'layer-edit-card-menu';
    list.setAttribute('data-layer-edit-chrome', '');
    list.append(...rows);
    return list;
  }

  // Under the widget when there is room, over it when not, always on the screen.
  function place(entry) {
    const root = ctx.api.root().getBoundingClientRect();
    const slot = entry.slot.getBoundingClientRect();
    const own = node.getBoundingClientRect();
    const left = Math.min(Math.max(EDGE_PX, slot.left - root.left), Math.max(EDGE_PX, root.width - own.width - EDGE_PX));
    const below = slot.bottom - root.top + TAG_PX;
    const fits = below + own.height <= root.height - EDGE_PX;
    const top = fits ? below : Math.max(EDGE_PX, slot.top - root.top - own.height - TAG_PX);
    node.style.setProperty('--layer-edit-x', left + 'px');
    node.style.setProperty('--layer-edit-y', top + 'px');
    ctx.api.refreshRects();
  }

  function draw(context) {
    ctx = context;
    const entry = ctx.entry();
    if (!entry) { hide(); return; }
    if (entry.key !== shownKey) open = '';
    shownKey = entry.key;
    if (!node) {
      node = document.createElement('div');
      node.className = 'layer-edit-card';
      node.setAttribute('role', 'group');
      node.setAttribute('data-layer-edit-chrome', '');
      ctx.api.root().appendChild(node);
    }
    fill();
  }

  function hide() {
    if (node) node.remove();
    node = null;
    open = '';
    shownKey = '';
  }

  window.LayerEditCard = Object.freeze({ draw, hide });
})();
