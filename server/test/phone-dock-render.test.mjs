import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'js', 'phone-view.js'), 'utf8');

// The thumb dock is the ONLY route to four controls on a phone: the compact
// topbar hides Search, Xenon AI, Apps and Settings to buy back its width. That
// makes every defect in this bar a control the user cannot reach at all, and
// none of it was covered — phone-view.test.mjs tests the two pure functions and
// reads the CSS as text, which cannot see a button that renders empty.
//
// Two real defects are pinned here, both reported or measured:
//
//  1. The buttons drew bare Unicode (⌕ ✦ ▦ ⚙) while every other control in the
//     app is an inline SVG. Those code points are whatever the device font
//     decides: on Android ⚙ commonly resolves to the colour emoji and ⌕/▦ to a
//     missing-glyph box. They are cloned from the real button now, so the dock
//     cannot drift from the topbar and cannot depend on a font.
//  2. The red "an update is available" dot lives on the topbar Settings button,
//     which is display:none here — so on a phone the user was never told. It is
//     mirrored onto the dock button, watching the real element rather than
//     hooking whatever writes it.
//
// Plus the arrangement itself: a mobile browser floats its own control over the
// bottom-right corner (the reported bug), so the pager takes that corner and the
// actions anchor left.

// ── A DOM small enough to read, big enough to run this module ────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeDom() {
  const observersFor = new Map();   // node -> [callback]

  function notify(node) {
    const cbs = observersFor.get(node);
    if (cbs) cbs.forEach((cb) => cb());
  }

  function mkEl(tag, ns) {
    const node = {
      tag,
      tagName: String(tag).toUpperCase(),
      namespaceURI: ns || null,
      id: '',
      className: '',
      attrs: Object.create(null),
      children: [],
      parentNode: null,
      _text: '',
      _hidden: false,
      _handlers: Object.create(null),
      style: { setProperty() {}, removeProperty() {} },
      dataset: Object.create(null),
      type: '',
      title: '',
      disabled: false,
    };
    Object.defineProperty(node, 'hidden', {
      get() { return node._hidden; },
      set(v) { node._hidden = !!v; notify(node); },
    });
    Object.defineProperty(node, 'textContent', {
      get() { return node._text + node.children.map((c) => c.textContent).join(''); },
      set(v) { node._text = String(v); node.children = []; },
    });
    node.classList = {
      add: (...c) => { node.className = [...new Set(node.className.split(/\s+/).filter(Boolean).concat(c))].join(' '); },
      remove: (...c) => { node.className = node.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => node.className.split(/\s+/).includes(c),
      toggle: (c, on) => (on ? node.classList.add(c) : node.classList.remove(c)),
    };
    node.setAttribute = (k, v) => {
      node.attrs[k] = String(v);
      if (k === 'class') node.className = String(v);
      if (k === 'id') node.id = String(v);
      notify(node);
    };
    node.getAttribute = (k) => (k in node.attrs ? node.attrs[k] : null);
    node.removeAttribute = (k) => { delete node.attrs[k]; if (k === 'id') node.id = ''; };
    node.hasAttribute = (k) => k in node.attrs;
    node.appendChild = (child) => {
      if (child && child._isFragment) { child.children.forEach(node.appendChild); return child; }
      if (child.parentNode) child.remove();
      child.parentNode = node;
      node.children.push(child);
      return child;
    };
    node.append = (...kids) => kids.forEach(node.appendChild);
    node.remove = () => {
      if (!node.parentNode) return;
      const at = node.parentNode.children.indexOf(node);
      if (at >= 0) node.parentNode.children.splice(at, 1);
      node.parentNode = null;
    };
    node.addEventListener = (type, fn) => { (node._handlers[type] ||= []).push(fn); };
    node.click = () => (node._handlers.click || []).forEach((fn) => fn({}));
    node.cloneNode = () => {
      const copy = mkEl(node.tag, node.namespaceURI);
      copy.className = node.className;
      copy.id = node.id;
      Object.assign(copy.attrs, node.attrs);
      copy._text = node._text;
      node.children.forEach((c) => copy.appendChild(c.cloneNode(true)));
      return copy;
    };
    node.querySelector = (sel) => find(node, sel)[0] || null;
    node.querySelectorAll = (sel) => find(node, sel);
    return node;
  }

  // Descendant selectors of class/tag/#id tokens. Enough for every selector
  // phone-view.js uses, and small enough that the test is readable.
  function matches(node, part) {
    const tokens = part.match(/[.#]?[\w-]+/g) || [];
    return tokens.every((tk) => {
      if (tk[0] === '.') return node.classList.contains(tk.slice(1));
      if (tk[0] === '#') return node.id === tk.slice(1);
      return node.tagName === tk.toUpperCase();
    });
  }
  function descendants(node, out = []) {
    node.children.forEach((c) => { out.push(c); descendants(c, out); });
    return out;
  }
  function find(root, sel) {
    const parts = sel.trim().split(/\s+(?![^[]*\])/);
    let scope = [root];
    for (const part of parts) {
      const next = [];
      scope.forEach((n) => descendants(n).forEach((d) => { if (matches(d, part) && !next.includes(d)) next.push(d); }));
      scope = next;
    }
    return scope;
  }

  const documentElement = mkEl('html');
  const body = mkEl('body');
  documentElement.appendChild(body);

  const document = {
    documentElement,
    body,
    readyState: 'complete',
    createElement: (t) => mkEl(t),
    createElementNS: (ns, t) => mkEl(t, ns),
    createDocumentFragment: () => {
      const f = mkEl('#fragment');
      f._isFragment = true;
      return f;
    },
    querySelector: (s) => find(documentElement, s)[0] || null,
    querySelectorAll: (s) => find(documentElement, s),
    getElementById: (id) => descendants(documentElement).find((n) => n.id === id) || null,
    addEventListener() {},
  };

  class MutationObserver {
    constructor(cb) { this.cb = cb; this.targets = []; }
    observe(target) {
      this.targets.push(target);
      (observersFor.get(target) || observersFor.set(target, []).get(target)).push(this.cb);
    }
    disconnect() {
      this.targets.forEach((tgt) => {
        const cbs = observersFor.get(tgt) || [];
        const at = cbs.indexOf(this.cb);
        if (at >= 0) cbs.splice(at, 1);
      });
      this.targets = [];
    }
  }

  return { document, mkEl, MutationObserver, observersFor };
}

/** A topbar button as index.html really writes it: an inline SVG plus a label. */
function topButton(mkEl, cls, pathD) {
  const b = mkEl('button');
  b.className = 'topbtn ' + cls;
  const svg = mkEl('svg', SVG_NS);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('id', 'icon-' + cls);        // an id the clone must not keep
  const p = mkEl('path', SVG_NS);
  p.setAttribute('d', pathD);
  svg.appendChild(p);
  b.appendChild(svg);
  return b;
}

const LABELS = {
  ph_search: 'Cerca',
  ph_ai: 'Xenon AI',
  ph_apps: 'App',
  ph_settings: 'Impostazioni',
  ph_prev: 'Pagina precedente',
  ph_next: 'Pagina successiva',
  ph_send: 'Invia',
  xfer_dock: 'Invia al PC',
  ph_dock: 'Comandi rapidi',
};

function mountPhone({ pages = 3, width = 390, height = 844 } = {}) {
  const dom = makeDom();
  const { document, mkEl } = dom;

  const shell = mkEl('div');
  shell.className = 'shell';
  document.body.appendChild(shell);

  const topbar = mkEl('header');
  topbar.className = 'topbar';
  shell.appendChild(topbar);
  topbar.append(
    topButton(mkEl, 'qbtn-search', 'M10 2a8 8 0 1 1 0 16Z'),
    topButton(mkEl, 'topbtn-xenon', 'M12 0 12.7 6.1Z'),
    topButton(mkEl, 'qbtn-apps', 'M4 4h7v7H4Z'),
  );
  const settings = topButton(mkEl, 'qbtn-settings', 'M19.4 13.5Z');
  const dot = mkEl('span');
  dot.className = 'topbtn-update-dot';
  dot.setAttribute('id', 'settings-update-dot');
  dot.hidden = true;
  settings.appendChild(dot);
  topbar.appendChild(settings);

  const dotsHost = mkEl('span');
  dotsHost.className = 'pager-dots';
  dotsHost.setAttribute('id', 'pager-dots');
  for (let i = 0; i < pages; i++) {
    const d = mkEl('button');
    d.className = 'pager-dot' + (i === 0 ? ' is-active' : '');
    dotsHost.appendChild(d);
  }
  topbar.appendChild(dotsHost);

  const pager = mkEl('div');
  pager.className = 'pager';
  shell.appendChild(pager);

  const sandbox = {
    document,
    window: null,
    MutationObserver: dom.MutationObserver,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    console: { warn: () => {} },
    t: (k) => LABELS[k] || '',
    module: undefined,
  };
  sandbox.window = sandbox;
  sandbox.window.innerWidth = width;
  sandbox.window.innerHeight = height;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'phone-view.js' });

  return { ...dom, sandbox, shell, settingsDot: dot, PhoneView: sandbox.PhoneView };
}

// ── The arrangement ──────────────────────────────────────────────────────────

test('the dock mounts as a row of the shell with the actions before the pager', () => {
  const { shell } = mountPhone();
  const dock = shell.querySelector('.ph-dock');
  assert.ok(dock, 'the dock was never built');
  assert.equal(dock.parentNode, shell, 'the dock must be a row of the shell, not a floating bar');

  const order = dock.children.map((c) => c.className);
  assert.deepEqual(order, ['ph-acts', 'ph-pages'],
    'the actions must come first: a mobile browser floats its own control over the bottom-right corner, '
    + 'and the pager is the only dock control with a second route (swiping)');
});

test('every action button carries the real icon of the control it forwards to', () => {
  const { shell } = mountPhone();
  const acts = shell.querySelectorAll('.ph-acts .ph-act');
  assert.equal(acts.length, 4, 'search, AI, apps and settings');

  for (const b of acts) {
    const svg = b.querySelector('svg');
    assert.ok(svg, 'a dock button fell back to a Unicode glyph: ' + b.title);
    assert.equal(svg.namespaceURI, SVG_NS, 'the icon must be a real SVG element');
    assert.ok(b.querySelector('path'), 'the cloned icon lost its path');
    // A clone that keeps the original's id answers to anything that addressed it.
    assert.equal(svg.getAttribute('id'), null, 'the cloned icon must not keep the original id');
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
  }
});

test('every action button is labelled, visibly and accessibly', () => {
  const { shell } = mountPhone();
  const labels = shell.querySelectorAll('.ph-acts .ph-lab').map((n) => n.textContent);
  assert.deepEqual(labels, ['Cerca', 'Xenon AI', 'App', 'Impostazioni']);

  for (const b of shell.querySelectorAll('.ph-acts .ph-act')) {
    assert.ok(b.getAttribute('aria-label'), 'a dock button with no accessible name');
    assert.ok(b.title, 'a dock button with no tooltip');
  }
  // The pager steps are chevrons; without a name they announce as "‹" and "›".
  for (const cls of ['.ph-prev', '.ph-next']) {
    const b = shell.querySelector(cls);
    assert.ok(b.getAttribute('aria-label'), cls + ' must carry an accessible name');
  }
});

test('a dock button forwards its tap to the real control, never re-implements it', () => {
  const { shell } = mountPhone();
  let opened = 0;
  shell.querySelector('.qbtn-settings').addEventListener('click', () => { opened++; });
  const settingsDock = shell.querySelectorAll('.ph-acts .ph-act')[3];
  settingsDock._handlers.click.forEach((fn) => fn({}));
  assert.equal(opened, 1, 'the dock button must click the real topbar button');
});

// ── The mirrored indicator ───────────────────────────────────────────────────

test('the update dot reaches the phone, because the button that carries it does not', () => {
  const { shell, settingsDot } = mountPhone();
  const settingsDock = shell.querySelectorAll('.ph-acts .ph-act')[3];
  const copy = settingsDock.querySelector('.ph-dot');
  assert.ok(copy, 'the Settings dock button must carry a mirror of the update dot');
  assert.equal(copy.hidden, true, 'nothing to announce yet');

  settingsDot.hidden = false;              // update.js flips exactly this element
  assert.equal(copy.hidden, false, 'the mirror must follow the real dot');
  settingsDot.hidden = true;
  assert.equal(copy.hidden, true, 'and follow it back — the dot clears itself after an update');

  // One element owns the state. A second id would be a second thing to keep in
  // step, and update.js addresses it by id.
  assert.equal(copy.getAttribute('id'), null);
});

test('leaving the phone view stops the mirror it started', () => {
  const { shell, settingsDot, observersFor, PhoneView } = mountPhone();
  assert.equal((observersFor.get(settingsDot) || []).length, 1, 'the mirror should be watching');
  PhoneView.disable();
  assert.equal(shell.querySelector('.ph-dock'), null, 'the dock must go');
  assert.equal((observersFor.get(settingsDot) || []).length, 0,
    'an observer that outlives its element keeps a dead subtree alive on every rotation');
});

// ── Registered actions ───────────────────────────────────────────────────────

test('a registered action gets an icon and a short caption of its own', () => {
  const { shell, PhoneView } = mountPhone();
  PhoneView.addDockAction({
    id: 'transfer',
    icon: 'M12 2.6 18 8.6Z',
    glyph: '⇪',
    key: 'xfer_dock',
    short: 'ph_send',
    run: () => {},
  });
  const first = shell.querySelectorAll('.ph-acts .ph-act')[0];
  assert.ok(first.classList.contains('ph-btn-action'), 'a registered action leads the bar');
  assert.ok(first.querySelector('svg'), 'the supplied path must become a real SVG');
  assert.equal(first.querySelector('path').getAttribute('d'), 'M12 2.6 18 8.6Z');
  // The full name is the accessible one; the caption is the short form, because
  // "An den PC senden" under a 48px button is an ellipsis.
  assert.equal(first.getAttribute('aria-label'), 'Invia al PC');
  assert.equal(first.querySelector('.ph-lab').textContent, 'Invia');
});

test('rebuilding the dock does not leave a second mirror behind', () => {
  const { shell, settingsDot, observersFor, PhoneView } = mountPhone();
  for (let i = 0; i < 3; i++) {
    PhoneView.addDockAction({ id: 'transfer', icon: 'M0 0Z', key: 'xfer_dock', short: 'ph_send', run: () => {} });
  }
  assert.equal((observersFor.get(settingsDot) || []).length, 1,
    'each rebuild must tear its observers down, or they accumulate for the life of the page');
  assert.equal(shell.querySelectorAll('.ph-dock').length, 1, 'exactly one dock');
  assert.equal(shell.querySelectorAll('.ph-acts .ph-act').length, 5);
});

test('a removed action leaves the bar, and takes nothing else with it', () => {
  const { shell, PhoneView } = mountPhone();
  PhoneView.addDockAction({ id: 'transfer', icon: 'M0 0Z', key: 'xfer_dock', short: 'ph_send', run: () => {} });
  assert.equal(shell.querySelectorAll('.ph-acts .ph-act').length, 5);
  PhoneView.addDockAction({ id: 'transfer', remove: true });
  const left = shell.querySelectorAll('.ph-acts .ph-lab').map((n) => n.textContent);
  assert.deepEqual(left, ['Cerca', 'Xenon AI', 'App', 'Impostazioni']);
});

// ── The pager ────────────────────────────────────────────────────────────────

test('the pager shows the real page count and disables the ends', () => {
  const { shell } = mountPhone({ pages: 3 });
  const dock = shell.querySelector('.ph-dock');
  assert.ok(dock.classList.contains('has-pages'));
  assert.equal(dock.querySelector('.ph-page-at').textContent, '1/3');
  assert.equal(dock.querySelector('.ph-prev').disabled, true, 'nowhere to go back to');
  assert.equal(dock.querySelector('.ph-next').disabled, false);
});

test('a single-page dashboard leaves the corner a browser steals completely empty', () => {
  const { shell } = mountPhone({ pages: 1 });
  const dock = shell.querySelector('.ph-dock');
  assert.equal(dock.classList.contains('has-pages'), false,
    'with one page the pager is hidden, so nothing at all sits in the bottom-right corner');
  assert.equal(dock.querySelectorAll('.ph-act').length, 4, 'the actions are unaffected');
});
