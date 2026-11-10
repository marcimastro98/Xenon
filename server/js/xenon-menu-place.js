'use strict';

// When a widget is seen, in the Xenon menu: four cards, each with a small figure of what
// it means. Three are one tap. "On an app" asks which one from the apps open now, each
// with the picture the system gives it (capabilities/layer-anchor.js), and tapping one
// attaches the widget.
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./layer-when.js') : root.LayerWhen);
  if (node) module.exports = api;
  if (root) root.XenonMenuPlace = api;
})(typeof window !== 'undefined' ? window : globalThis, function (rules) {
  const PICTURE_RE = /^data:image\/(?:png|svg\+xml);base64,/;
  const SVG = 'http://www.w3.org/2000/svg';
  // A screen, a window and the widget where it lives: x, y, w, h and what each is.
  const FIGURES = Object.freeze({
    always: [[14, 10, 56, 34, 'win'], [62, 6, 26, 18, 'widget']],
    desktop: [[62, 6, 26, 18, 'widget'], [14, 10, 56, 34, 'win']],
    game: [[6, 34, 84, 2, 'ground'], [30, 22, 6, 12, 'ground'], [70, 6, 20, 12, 'widget']],
    anchor: [[14, 8, 66, 38, 'win'], [14, 8, 66, 7, 'bar'], [56, 30, 20, 12, 'widget']],
    moments: [[14, 10, 56, 34, 'win'], [62, 6, 26, 18, 'faint']],
  });

  function figure(kind) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 96 54');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', `xm-fig xm-fig--${kind}`);
    const part = (x, y, width, height, cls) => {
      const r = document.createElementNS(SVG, 'rect');
      for (const [name, value] of Object.entries({ x, y, width, height, rx: 2 })) r.setAttribute(name, String(value));
      r.setAttribute('class', 'xm-fig-' + cls);
      svg.appendChild(r);
    };
    part(0.5, 0.5, 95, 53, 'desk');
    for (const f of FIGURES[kind] || []) part(...f);
    return svg;
  }

  // Null when there is no usable picture: the name stands alone then.
  function picture(el, src) {
    if (!PICTURE_RE.test(String(src || ''))) return null;
    const img = el('img', 'xm-app-icon');
    img.src = src;
    img.alt = '';
    return img;
  }

  // ctx: { el, button, say, tt, rowShell, perform, post, showError, redraw }
  function create(ctx) {
    const { el, button, say, tt, rowShell, perform, post, showError, redraw } = ctx;
    let picking = '';   // the row whose app list is open
    let apps = null;    // that list: null while it is asked for

    const close = () => { picking = ''; apps = null; };

    async function askApps(r) {
      picking = r.id;
      apps = null;
      redraw();
      const res = await post('/actions/run', { type: 'layerAnchor', mode: 'apps', pictures: 'on' }).catch(() => null);
      if (picking !== r.id) return;
      if (!res || res.ok === false) {
        close();
        showError((res && res.error) || 'unavailable');
      } else {
        apps = res.apps || [];
      }
      redraw();
    }

    function chip(r, o) {
      const here = o.value === r.value;
      // While the list is open, "On an app" is what the person is doing.
      const on = picking === r.id ? !o.act && !o.press : here;
      const b = button(r.cards ? 'xm-seecard' : 'xm-choice', r.cards ? null : say(o.label));
      if (r.cards) b.append(figure(o.value), el('b', '', say(o.label)), el('span', 'xm-sub', say(o.sub)));
      b.setAttribute('aria-pressed', String(on));
      b.dataset.keep = `${r.id}:${o.value}`;
      b.addEventListener('click', () => {
        // A card the page around it answers itself (the widget's own screen).
        if (o.press) { close(); o.press(here); return; }
        if (!o.act) { if (picking === r.id) { close(); redraw(); } else askApps(r); return; }
        close();
        if (here) redraw();
        else perform(r, o.act);
      });
      return b;
    }

    function appList(r) {
      const box = el('div', 'xm-place-apps');
      if (apps === null) return box;
      box.appendChild(el('p', 'xm-sub xm-place-ask', tt(apps.length ? 'layer_edit_attach_hint' : 'layer_edit_attach_none')));
      const list = el('div', 'xm-choices');
      for (const a of apps) {
        const b = button('xm-choice xm-app', rules.appName(a.app));
        const face = picture(el, a.icon);
        if (face) b.prepend(face);
        b.addEventListener('click', () => {
          close();
          perform(r, { run: { type: 'layerAnchor', widget: r.widget, app: a.app } });
        });
        list.appendChild(b);
      }
      box.appendChild(list);
      return box;
    }

    function says(r, chosen) {
      const line = el('p', 'xm-sub xm-place-says', say(chosen.sub));
      const face = picture(el, chosen.icon);
      if (face) line.prepend(face);
      if (r.value !== 'anchor') return line;
      const change = button('xm-link', tt('xmenu_change_app'));
      change.addEventListener('click', () => askApps(r));
      line.appendChild(change);
      return line;
    }

    function draw(r) {
      const li = rowShell(r, 'xm-row--stack xm-row--place');
      const options = r.options || [];
      const group = el('div', r.cards ? 'xm-seecards' : 'xm-choices');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', say(r.label));
      group.append(...options.map((o) => chip(r, o)));
      li.appendChild(group);
      const chosen = options.find((o) => o.value === r.value);
      if (chosen && picking !== r.id && (!r.cards || r.value === 'anchor')) li.appendChild(says(r, chosen));
      if (r.note) li.appendChild(el('p', 'xm-sub xm-place-says', say(r.note)));
      if (picking === r.id) li.appendChild(appList(r));
      return li;
    }

    return { draw };
  }

  return { create, picture };
});
