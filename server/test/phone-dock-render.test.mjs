import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom, SVG_NS } from './mini-dom.mjs';

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
    ResizeObserver: dom.ResizeObserver,
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

// ── Nothing may float over the dock ──────────────────────────────────────────
//
// The dock is a grid ROW, and buildDock()'s comment explains at length that this
// settles every argument about what can end up underneath it. That is true of
// things the dashboard LAYS OUT and false of the things it FIXES to the
// viewport, which was never checked: eight elements are `position: fixed` with a
// bottom offset, and three of them (the Discord invite, the Game Companion pill,
// the layout button) sit in the bottom-RIGHT corner — the same corner this file
// spends its longest comment conceding to the browser.
//
// On a desktop they float over a wide empty margin. On a 390px phone they land
// on the bar. Reported while a game was running, which is when the Game
// Companion pill appears: it covered the controls it was sitting on.
//
// So the list in PhoneView.css is checked against the CSS itself rather than
// kept by hand. A new floater is a normal thing to add, and its author has no
// reason to know this view exists.

const COMPONENT_DIRS = [join(HERE, '..', 'components'), join(HERE, '..', 'styles')];

/** Every rule that pins something to the bottom of the VIEWPORT. */
function bottomFixedSelectors() {
  const found = new Map();                    // selector -> file
  const files = [];
  for (const dir of COMPONENT_DIRS) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const f of readdirSync(join(dir, entry.name))) {
          if (f.endsWith('.css')) files.push(join(dir, entry.name, f));
        }
      } else if (entry.name.endsWith('.css')) {
        files.push(join(dir, entry.name));
      }
    }
  }
  for (const file of files) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2];
      if (!/position:\s*fixed/.test(body)) continue;
      // A full-screen overlay is not a floater; it is the screen.
      if (/inset:\s*0/.test(body)) continue;
      const bottom = body.match(/(?:^|;|\s)bottom:\s*([^;]+)/);
      if (!bottom || bottom[1].trim() === 'auto') continue;
      if (/(?:^|;|\s)top:\s*0/.test(body) && bottom[1].trim() === '0') continue;
      for (const sel of m[1].split(',')) {
        const s = sel.trim().replace(/\s+/g, ' ');
        // Only ever the element's own class, so a state variant does not need
        // its own entry in the phone-view list.
        const cls = s.match(/\.[a-z][\w-]*/i);
        if (cls && !found.has(cls[0])) found.set(cls[0], basename(file));
      }
    }
  }
  return found;
}

test('everything the dashboard pins to the bottom of the screen clears the dock', () => {
  const css = readFileSync(join(HERE, '..', 'components', 'PhoneView', 'PhoneView.css'), 'utf8');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Two ways to be safe on a phone: get lifted above the dock, or not be there.
  const lifted = new Set();
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    const liftsOrHides = /bottom:\s*calc\(\s*var\(--ph-dock-h/.test(body) || /display:\s*none/.test(body);
    if (!liftsOrHides) continue;
    for (const sel of m[1].split(',')) {
      const cls = sel.trim().match(/\.[a-z][\w-]*$/i);
      if (cls) lifted.add(cls[0]);
    }
  }

  const floaters = bottomFixedSelectors();
  assert.ok(floaters.size >= 6, 'the CSS scan found almost nothing — did the component layout move?');
  // The ones that made the report: a game pill and an invite card, in the corner.
  assert.ok(floaters.has('.gc-pill'), 'the Game Companion pill should have been found by the scan');
  assert.ok(floaters.has('.discord-invite'), 'the Discord invite should have been found by the scan');

  const missed = [...floaters].filter(([sel]) => !lifted.has(sel));
  assert.deepEqual(missed.map(([sel, file]) => sel + ' (' + file + ')'), [],
    'these are fixed to the bottom of the viewport and would land on the thumb dock. '
    + 'Add them to the clearance list in PhoneView.css (bottom: calc(var(--ph-dock-h) + 12px)) '
    + 'or hide them in the stacked view');
});

test('the dock publishes its own height, measured rather than assumed', () => {
  const { shell, document, resizeTargets, fireResize, PhoneView } = mountPhone();
  const dock = shell.querySelector('.ph-dock');
  const html = document.documentElement;
  assert.ok(dock, 'no dock to measure');

  // The dock wraps to a second line on a narrow screen and grows with the
  // safe-area inset, so the clearance cannot be a constant. It has to be
  // OBSERVED, not read once.
  assert.ok(resizeTargets().includes(dock),
    'the dock must be observed, or --ph-dock-h goes stale the first time it wraps');

  dock._rect.height = 64;
  fireResize();
  assert.equal(html.style.getPropertyValue('--ph-dock-h'), '64px');

  dock._rect.height = 108;                 // wrapped onto a second line
  fireResize();
  assert.equal(html.style.getPropertyValue('--ph-dock-h'), '108px',
    'a toast pinned to a one-line dock would sit on the second line');

  PhoneView.disable();
  assert.equal(html.style.getPropertyValue('--ph-dock-h'), '',
    'a stale height left on <html> keeps every toast floating for nothing');
});
